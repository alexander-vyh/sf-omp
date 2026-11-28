/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import sfPiManagerExtension from "../index.ts";
import {
  readAutoUpdateStatus,
  writeAutoUpdateEnabled,
} from "../../../lib/common/auto-update/store.ts";
import type * as WindowsSpawn from "../../../lib/common/windows-spawn.ts";
import { CHECKOUT_UPDATE, fakeExec } from "./checkout-exec.ts";

// Exec expectations below use bare command names; Windows command resolution
// is covered by lib/common/tests/windows-spawn.test.ts.
vi.mock("../../../lib/common/windows-spawn.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof WindowsSpawn>()),
  spawnCommand: (name: string, args: readonly string[]) => [name, [...args]],
}));

const PI_AGENT_ENV = "PI_CODING_AGENT_DIR";
type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<void> | void;

let tmpDir: string;
let previousAgentDir: string | undefined;
let previousOffline: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "sf-pi-update-runtime-"));
  previousAgentDir = process.env[PI_AGENT_ENV];
  process.env[PI_AGENT_ENV] = tmpDir;
  // The manager runs Auto Update with the process env; keep a developer's offline mode out.
  previousOffline = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  writeAutoUpdateEnabled(true);
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env[PI_AGENT_ENV];
  else process.env[PI_AGENT_ENV] = previousAgentDir;
  if (previousOffline !== undefined) process.env.PI_OFFLINE = previousOffline;
  rmSync(tmpDir, { recursive: true, force: true });
});

function context(): ExtensionContext {
  return {
    cwd: tmpDir,
    hasUI: true,
    mode: "tui",
    isIdle: () => true,
    signal: new AbortController().signal,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

/** Load the real manager factory against a fake exec for a behind sf-omp checkout. */
function loadManager() {
  const handlers = new Map<string, Handler>();
  const appendEntry = vi.fn();
  const { exec, calls } = fakeExec();
  const pi = {
    events: { on: vi.fn(), emit: vi.fn() },
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    appendEntry,
    exec,
  };
  sfPiManagerExtension(pi as never);
  return { handlers, appendEntry, exec, calls };
}

describe("Auto Update through the real SF Pi Manager factory", () => {
  it("waits for a terminal agent_end, emits the plan, and then updates the checkout and Salesforce CLI", async () => {
    const { handlers, appendEntry, exec, calls } = loadManager();
    const ctx = context();

    // OMP 19 emits session_start without a reason, once per runtime start.
    await handlers.get("session_start")?.({ type: "session_start" }, ctx);
    expect(calls).toEqual([]);

    // OMP marks non-terminal ends (retry, compaction, follow-up) with willContinue.
    await handlers.get("agent_end")?.({ type: "agent_end", messages: [], willContinue: true }, ctx);
    expect(calls).toEqual([]);

    await handlers.get("agent_end")?.(
      { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] },
      ctx,
    );

    expect(calls).toEqual([...CHECKOUT_UPDATE, "sf update stable"]);
    const plannedCall = appendEntry.mock.calls.findIndex(
      ([type, data]) => type === "sf-pi-auto-update" && data.title === "Auto Update planned",
    );
    const completedCall = appendEntry.mock.calls.findIndex(
      ([type, data]) => type === "sf-pi-auto-update" && data.title === "Auto Update complete",
    );
    expect(plannedCall).toBeGreaterThanOrEqual(0);
    expect(completedCall).toBeGreaterThan(plannedCall);
    // The plan is persisted before the first mutation, the fast-forward pull.
    expect(appendEntry.mock.invocationCallOrder[plannedCall]).toBeLessThan(
      exec.mock.invocationCallOrder[calls.indexOf("git pull --ff-only --quiet")],
    );

    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  });

  it("defers pending updates when agent_end ends on an aborted assistant message", async () => {
    const { handlers, calls } = loadManager();
    const ctx = context();

    await handlers.get("session_start")?.({ type: "session_start" }, ctx);
    await handlers.get("agent_end")?.(
      {
        type: "agent_end",
        messages: [
          { role: "assistant", stopReason: "aborted" },
          { role: "toolResult", toolName: "bash" },
        ],
      },
      ctx,
    );

    expect(calls).toEqual([]);
    expect(readAutoUpdateStatus()).toMatchObject({ pending: true, running: false });

    await handlers.get("agent_end")?.(
      { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] },
      ctx,
    );
    expect(calls).toEqual([...CHECKOUT_UPDATE, "sf update stable"]);
  });
});
