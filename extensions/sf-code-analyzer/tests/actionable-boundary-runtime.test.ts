/* SPDX-License-Identifier: Apache-2.0 */
/** Offline proof of the native OMP hook boundary; no provider or org requests. */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDeferredCodeAnalyzerAutoScan } from "../lib/auto-scan.ts";

type Hook = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

function harness() {
  const hooks = new Map<string, Hook>();
  const appendEntry = vi.fn();
  const api = {
    on: (event: string, hook: Hook) => hooks.set(event, hook),
    appendEntry,
  };
  const runCodeAnalyzer = vi.fn().mockResolvedValue({
    kind: "run",
    ok: true,
    source: "code-analyzer-cli",
    command: "sf code-analyzer run",
    durationMs: 12,
    reportFile: "/tmp/offline-analyzer.json",
    exitCode: 0,
    run: {
      violations: [
        {
          engine: "pmd",
          rule: "ApexCRUDViolation",
          severity: 2,
          primaryLocationIndex: 0,
          locations: [{ file: "classes/Example.cls", startLine: 1, startColumn: 1 }],
          message: "Validate CRUD",
        },
      ],
    },
  });
  // The runtime factory accepts the full API; this harness implements only used hooks.
  const pi = api as unknown as ExtensionAPI;
  registerDeferredCodeAnalyzerAutoScan(pi, vi.fn(), {
    readSettings: () => ({
      autoScan: true,
      apexGuruAuto: false,
      sources: { autoScan: "default", apexGuruAuto: "default" },
    }),
    readReadiness: () => ({ status: "ready", summary: "ready" }),
    isReadyForAutoScan: () => true,
    runCodeAnalyzer,
    buildScanRecipeGuidance: () => ({ recipes: [], suggestions: [], text: "" }),
  });
  // No UI or session-manager functionality is used by the deferred scan.
  const ctx = { cwd: "/tmp/offline-diagnostics" } as ExtensionContext;
  const changedFile = () =>
    hooks.get("tool_result")?.(
      {
        toolName: "write",
        input: { path: "classes/Example.cls" },
        content: [],
        isError: false,
        details: {},
      },
      ctx,
    );
  const stop = (signal: AbortSignal) =>
    hooks.get("session_stop")?.(
      {
        type: "session_stop",
        messages: [],
        turn_id: 1,
        session_id: "offline-native-boundary",
        stop_hook_active: false,
        signal,
      },
      ctx,
    );
  return { hooks, appendEntry, runCodeAnalyzer, changedFile, stop };
}

describe("OMP session_stop Code Analyzer boundary", () => {
  it("returns repair context without replacing or fabricating session entries", async () => {
    const h = harness();
    await h.changedFile();
    const result = await h.stop(new AbortController().signal);
    expect(h.hooks.has("agent_before_settle")).toBe(false);
    expect(result).toEqual({
      continue: true,
      additionalContext: expect.stringContaining("ApexCRUDViolation"),
    });
    expect(h.appendEntry).toHaveBeenCalledWith(
      "sf-code-analyzer",
      expect.objectContaining({
        details: expect.objectContaining({ status: "findings" }),
      }),
    );
    expect(await h.stop(new AbortController().signal)).toBeUndefined();
    expect(h.runCodeAnalyzer).toHaveBeenCalledOnce();
  });

  it("retains pending targets when an already-aborted settle pass is skipped", async () => {
    const h = harness();
    await h.changedFile();
    const controller = new AbortController();
    controller.abort();
    expect(await h.stop(controller.signal)).toBeUndefined();
    expect(h.runCodeAnalyzer).not.toHaveBeenCalled();
    expect(await h.stop(new AbortController().signal)).toMatchObject({ continue: true });
  });

  it("does not request a repair continuation after a scan is cancelled", async () => {
    const h = harness();
    const controller = new AbortController();
    h.runCodeAnalyzer.mockImplementationOnce(async () => {
      controller.abort();
      return { run: { violations: [] } };
    });
    await h.changedFile();
    expect(await h.stop(controller.signal)).toBeUndefined();
  });
});
