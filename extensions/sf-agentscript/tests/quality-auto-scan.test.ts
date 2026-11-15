/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SCRIPT_QUALITY_ENTRY_TYPE,
  registerDeferredAgentScriptQuality,
} from "../lib/quality/auto-scan.ts";
import { AGENT_SCRIPT_QUALITY_RULES } from "../lib/quality/catalog.ts";
import type { AgentScriptQualityResult } from "../lib/quality/types.ts";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "sf-agentscript-quality-auto-"));
});
afterEach(async () => rm(cwd, { recursive: true, force: true }));

type Handler = (...args: unknown[]) => unknown;

function harness() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };
  return { pi, handlers };
}

function result(findings: AgentScriptQualityResult["findings"]): AgentScriptQualityResult {
  return {
    ok: true,
    status: findings.length ? "findings" : "clean",
    findings,
    summary: {
      high: findings.filter((item) => item.severity === "high").length,
      moderate: findings.filter((item) => item.severity === "moderate").length,
      low: 0,
      info: 0,
    },
    metrics: { cyclomatic_complexity: [] },
    coverage: {
      total_rules: AGENT_SCRIPT_QUALITY_RULES.length,
      enabled_rules: AGENT_SCRIPT_QUALITY_RULES.length,
      disabled_rules: [],
    },
    suppressions: { applied: [], invalid: [], unused: [] },
  };
}

function stopEvent(signal = new AbortController().signal) {
  return {
    type: "session_stop",
    messages: [],
    turn_id: 1,
    session_id: "test-session",
    stop_hook_active: false,
    signal,
  };
}

const finding = {
  rule_id: "unused-action" as const,
  rule_name: "Unused Action",
  severity: "moderate" as const,
  message: "unused",
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  line: 1,
};

describe("deferred Agent Script quality", () => {
  it("returns one actionable repair boundary for High/Moderate findings", async () => {
    const { pi, handlers } = harness();
    const file = path.join(cwd, "A.agent");
    await writeFile(file, "x");
    registerDeferredAgentScriptQuality(pi as never, {
      readSettings: () => ({ autoRun: true }) as never,
      runQualityFile: async () => result([finding]),
    });
    const ctx = { cwd } as never;
    await handlers.get("tool_result")?.[0]?.(
      { isError: false, input: { path: file }, toolName: "write" },
      ctx,
    );
    expect(pi.sendMessage).not.toHaveBeenCalled();
    const boundary = await handlers.get("session_stop")?.[0]?.(stopEvent(), ctx);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      AGENT_SCRIPT_QUALITY_ENTRY_TYPE,
      expect.objectContaining({
        schema_version: 1,
        state: "repairing",
        quality: expect.objectContaining({ findings: [finding] }),
      }),
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(boundary).toMatchObject({
      continue: true,
      additionalContext: expect.any(String),
    });
    expect(boundary).not.toHaveProperty("entries");
    const context =
      boundary && typeof boundary === "object" && "additionalContext" in boundary
        ? boundary.additionalContext
        : undefined;
    expect(JSON.parse(String(context))).toMatchObject({
      version: 1,
      task: "repair_agent_script_quality",
      attempt: 1,
      findings: [expect.objectContaining({ rule_id: "unused-action", severity: "moderate" })],
    });
  });

  it("keeps clean and low/info-only results human-only", async () => {
    const { pi, handlers } = harness();
    const file = path.join(cwd, "A.agent");
    await writeFile(file, "x");
    registerDeferredAgentScriptQuality(pi as never, {
      readSettings: () => ({ autoRun: true }) as never,
      runQualityFile: async () => result([]),
    });
    const ctx = { cwd } as never;
    await handlers.get("tool_result")?.[0]?.(
      { isError: false, input: { path: file }, toolName: "edit" },
      ctx,
    );
    const boundary = await handlers.get("session_stop")?.[0]?.(stopEvent(), ctx);
    expect(boundary).toBeUndefined();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      AGENT_SCRIPT_QUALITY_ENTRY_TYPE,
      expect.objectContaining({ state: "passed" }),
    );
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("stops repeated finding signatures", async () => {
    const { pi, handlers } = harness();
    const file = path.join(cwd, "A.agent");
    await writeFile(file, "x");
    registerDeferredAgentScriptQuality(pi as never, {
      readSettings: () => ({ autoRun: true }) as never,
      runQualityFile: async () => result([finding]),
    });
    const ctx = { cwd } as never;
    const boundaries = [];
    for (let turn = 0; turn < 2; turn++) {
      await handlers.get("tool_result")?.[0]?.(
        { isError: false, input: { path: file }, toolName: "edit" },
        ctx,
      );
      boundaries.push(await handlers.get("session_stop")?.[0]?.(stopEvent(), ctx));
    }
    expect(boundaries[0]).toMatchObject({ continue: true });
    expect(boundaries[1]).toBeUndefined();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      AGENT_SCRIPT_QUALITY_ENTRY_TYPE,
      expect.objectContaining({ state: "stopped" }),
    );
  });

  it("emits a fixed card when a repair is followed by a clean result", async () => {
    const { pi, handlers } = harness();
    const file = path.join(cwd, "A.agent");
    await writeFile(file, "x");
    let pass = 0;
    registerDeferredAgentScriptQuality(pi as never, {
      readSettings: () => ({ autoRun: true }) as never,
      runQualityFile: async () => (pass++ === 0 ? result([finding]) : result([])),
    });
    const ctx = { cwd } as never;
    const boundaries = [];
    for (let turn = 0; turn < 2; turn++) {
      await handlers.get("tool_result")?.[0]?.(
        { isError: false, input: { path: file }, toolName: "edit" },
        ctx,
      );
      boundaries.push(await handlers.get("session_stop")?.[0]?.(stopEvent(), ctx));
    }
    expect(boundaries[0]).toMatchObject({ continue: true });
    expect(boundaries[1]).toBeUndefined();
    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      AGENT_SCRIPT_QUALITY_ENTRY_TYPE,
      expect.objectContaining({ state: "fixed", repair: expect.objectContaining({ attempt: 1 }) }),
    );
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("retains pending scans and repair state when a stop pass is cancelled", async () => {
    const { pi, handlers } = harness();
    const controller = new AbortController();
    const file = path.join(cwd, "A.agent");
    let calls = 0;
    registerDeferredAgentScriptQuality(pi as never, {
      readSettings: () => ({ autoRun: true }),
      runQualityFile: async () => {
        if (calls++ === 0) controller.abort();
        return result([finding]);
      },
    });
    const ctx = { cwd } as never;
    await handlers.get("tool_result")?.[0]?.(
      { isError: false, input: { path: file }, toolName: "write" },
      ctx,
    );
    expect(
      await handlers.get("session_stop")?.[0]?.(stopEvent(controller.signal), ctx),
    ).toBeUndefined();
    expect(pi.appendEntry).not.toHaveBeenCalled();
    const boundary = await handlers.get("session_stop")?.[0]?.(stopEvent(), ctx);
    expect(boundary).toMatchObject({ continue: true });
    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      AGENT_SCRIPT_QUALITY_ENTRY_TYPE,
      expect.objectContaining({ repair: expect.objectContaining({ attempt: 1 }) }),
    );
  });

  it("presents quality as a real human-only OMP widget", async () => {
    const { pi, handlers } = harness();
    const setWidget = vi.fn();
    registerDeferredAgentScriptQuality(pi as never, {
      readSettings: () => ({ autoRun: true }),
      runQualityFile: async () => result([]),
    });
    const ctx = { cwd, mode: "tui", ui: { setWidget } };
    await handlers.get("tool_result")?.[0]?.(
      { isError: false, input: { path: "A.agent" }, toolName: "write" },
      ctx,
    );
    await handlers.get("session_stop")?.[0]?.(stopEvent(), ctx);
    expect(setWidget).toHaveBeenCalledWith(AGENT_SCRIPT_QUALITY_ENTRY_TYPE, expect.any(Function));
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});
