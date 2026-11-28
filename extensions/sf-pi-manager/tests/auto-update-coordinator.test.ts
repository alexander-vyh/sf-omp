/* SPDX-License-Identifier: Apache-2.0 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  readAutoUpdateStatus,
  writeAutoUpdateEnabled,
} from "../../../lib/common/auto-update/store.ts";
import type * as WindowsSpawn from "../../../lib/common/windows-spawn.ts";
import { createAgentSettledUpdateCoordinator } from "../lib/auto-update-coordinator.ts";
import { AUTO_UPDATE_ENTRY_TYPE } from "../lib/auto-update-transcript.ts";
import { CHECKOUT_UPDATE, behindCheckoutReply, type ExecResult } from "./checkout-exec.ts";

// Exec expectations below use bare command names; Windows command resolution
// is covered by lib/common/tests/windows-spawn.test.ts and the native OMP proof.
vi.mock("../../../lib/common/windows-spawn.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof WindowsSpawn>()),
  spawnCommand: (name: string, args: readonly string[]) => [name, [...args]],
}));

const PI_AGENT_ENV = "PI_CODING_AGENT_DIR";
const PULL = "git pull --ff-only --quiet";

let tmpDir: string;
let previousAgentDir: string | undefined;
let previousOffline: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "sf-pi-update-coordinator-"));
  mkdirSync(tmpDir, { recursive: true });
  previousAgentDir = process.env[PI_AGENT_ENV];
  process.env[PI_AGENT_ENV] = tmpDir;
  // The coordinator runs with the process env; keep a developer's offline mode out.
  previousOffline = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env[PI_AGENT_ENV];
  else process.env[PI_AGENT_ENV] = previousAgentDir;
  if (previousOffline !== undefined) process.env.PI_OFFLINE = previousOffline;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A behind checkout whose exec records each command line and runs `onCall` first. */
function recordingPi(onCall: (line: string) => void = () => undefined) {
  const calls: string[] = [];
  const appendEntry = vi.fn();
  const exec = vi.fn(async (command: string, args: string[]) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    onCall(line);
    return behindCheckoutReply(command, args);
  });
  return { pi: { exec, appendEntry } as unknown as ExtensionAPI, exec, appendEntry, calls };
}

/** A behind checkout whose `git pull` hangs until the run's signal aborts. */
function hangingPullPi() {
  const calls: string[] = [];
  const appendEntry = vi.fn();
  const exec = vi.fn(
    (command: string, args: string[], options?: { signal?: AbortSignal }) =>
      new Promise<ExecResult>((resolve) => {
        const line = [command, ...args].join(" ");
        calls.push(line);
        if (line !== PULL) {
          resolve(behindCheckoutReply(command, args));
          return;
        }
        options?.signal?.addEventListener(
          "abort",
          () => resolve({ stdout: "", stderr: "", code: 1, killed: true }),
          { once: true },
        );
      }),
  );
  return { pi: { exec, appendEntry } as unknown as ExtensionAPI, appendEntry, calls };
}

function context(idle: boolean = true): ExtensionContext {
  return {
    cwd: tmpDir,
    hasUI: true,
    isIdle: () => idle,
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  } as unknown as ExtensionContext;
}

describe("Agent-Settled Update Coordinator", () => {
  it("does not schedule automatic mutations in headless sessions", async () => {
    writeAutoUpdateEnabled(true);
    const { pi, exec } = recordingPi();
    const updateCoordinator = createAgentSettledUpdateCoordinator(pi);
    const ctx = { ...context(), hasUI: false } as ExtensionContext;

    updateCoordinator.onSessionStart(ctx);
    await updateCoordinator.onAgentSettled(ctx);

    expect(exec).not.toHaveBeenCalled();
    expect(readAutoUpdateStatus().pending).not.toBe(true);
  });

  it("records due work at startup and waits for agent_settled before mutating", async () => {
    writeAutoUpdateEnabled(true);
    const { pi, appendEntry, calls } = recordingPi();
    const coordinator = createAgentSettledUpdateCoordinator(pi);
    const ctx = context();

    coordinator.onSessionStart(ctx);

    expect(calls).toEqual([]);
    expect(readAutoUpdateStatus()).toMatchObject({ pending: true, running: false });

    await coordinator.onAgentSettled(ctx);

    expect(calls).toEqual([...CHECKOUT_UPDATE, "sf update stable"]);
    expect(calls.filter((call) => /^(?:omp|pi) /.test(call))).toEqual([]);
    expect(appendEntry).toHaveBeenCalledWith(
      AUTO_UPDATE_ENTRY_TYPE,
      expect.objectContaining({
        title: "Auto Update planned",
        body: expect.stringMatching(
          /OMP runtime: native omp on PATH[\s\S]*sf-omp checkout: main is 2 commit\(s\) behind origin\/main\. Will run git pull --ff-only \+ npm ci\.[\s\S]*Salesforce CLI: update the stable channel/,
        ),
      }),
    );
    expect(appendEntry).toHaveBeenCalledWith(
      AUTO_UPDATE_ENTRY_TYPE,
      expect.objectContaining({
        title: "Auto Update complete",
        body: expect.stringMatching(
          /pi-runtime: skipped[\s\S]*sf-omp-checkout: success[\s\S]*sf-cli: success[\s\S]*Restart recommended: yes/,
        ),
      }),
    );
  });

  it("waits in the background for idleness after a settled turn, without blocking", async () => {
    writeAutoUpdateEnabled(true);
    const { pi, calls } = recordingPi();
    const coordinator = createAgentSettledUpdateCoordinator(pi);
    let idle = false;
    const ctx = { ...context(), isIdle: () => idle } as ExtensionContext;

    coordinator.onSessionStart(ctx);
    await coordinator.onAgentSettled(ctx);
    expect(calls).toEqual([]);

    idle = true;
    await vi.waitFor(() => expect(calls).toContain("sf update stable"));
  });

  it("drops the background idle wait when a new agent run starts", async () => {
    writeAutoUpdateEnabled(true);
    const { pi, exec } = recordingPi();
    const coordinator = createAgentSettledUpdateCoordinator(pi);
    let idle = false;
    const ctx = { ...context(), isIdle: () => idle } as ExtensionContext;

    vi.useFakeTimers();
    try {
      coordinator.onSessionStart(ctx);
      await coordinator.onAgentSettled(ctx);
      coordinator.onAgentStart();
      idle = true;
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    expect(exec).not.toHaveBeenCalled();
    expect(readAutoUpdateStatus()).toMatchObject({ pending: true, running: false });
  });

  it("defers pending automatic work after an aborted settlement", async () => {
    writeAutoUpdateEnabled(true);
    const { pi, exec, calls } = recordingPi();
    const coordinator = createAgentSettledUpdateCoordinator(pi);
    const ctx = context();

    coordinator.onSessionStart(ctx);
    await coordinator.onAgentSettled(ctx, true);

    expect(exec).not.toHaveBeenCalled();
    expect(readAutoUpdateStatus()).toMatchObject({ pending: true, running: false });

    await coordinator.onAgentSettled(ctx, false);
    expect(calls).toEqual([...CHECKOUT_UPDATE, "sf update stable"]);
  });

  it("prevents overlapping runs across coordinator instances", async () => {
    writeAutoUpdateEnabled(true);
    let releaseFirst: (() => void) | undefined;
    let firstCall = true;
    const firstPi = {
      exec: vi.fn((command: string, args: string[]) => {
        const reply = behindCheckoutReply(command, args);
        if (!firstCall) return Promise.resolve(reply);
        firstCall = false;
        return new Promise<ExecResult>((resolve) => {
          releaseFirst = () => resolve(reply);
        });
      }),
      appendEntry: vi.fn(),
    } as unknown as ExtensionAPI;
    const second = recordingPi();
    const first = createAgentSettledUpdateCoordinator(firstPi);
    const secondCoordinator = createAgentSettledUpdateCoordinator(second.pi);
    const ctx = context();

    first.onSessionStart(ctx);
    secondCoordinator.onSessionStart(ctx);
    const firstRun = first.onAgentSettled(ctx);
    await vi.waitFor(() => expect(firstPi.exec).toHaveBeenCalledOnce());

    await secondCoordinator.onAgentSettled(ctx);
    expect(second.exec).not.toHaveBeenCalled();

    releaseFirst?.();
    await firstRun;
    expect(firstPi.exec).toHaveBeenCalledTimes(CHECKOUT_UPDATE.length + 1);
  });

  it("rechecks opt-in before later targets and stops when consent is revoked", async () => {
    writeAutoUpdateEnabled(true);
    const { pi, calls } = recordingPi((line) => {
      if (line === "npm ci") writeAutoUpdateEnabled(false);
    });
    const coordinator = createAgentSettledUpdateCoordinator(pi);
    const ctx = context();

    coordinator.onSessionStart(ctx);
    await coordinator.onAgentSettled(ctx);

    expect(calls).toEqual(CHECKOUT_UPDATE);
    expect(readAutoUpdateStatus()).toMatchObject({
      pending: false,
      lastResult: "skipped",
      restartRecommended: true,
      targets: expect.arrayContaining([
        expect.objectContaining({ target: "sf-omp-checkout", result: "success" }),
        expect.objectContaining({ target: "sf-cli", result: "skipped" }),
      ]),
    });
  });

  it("rechecks opt-in after planning and never pulls once consent is revoked", async () => {
    writeAutoUpdateEnabled(true);
    const { pi, calls } = recordingPi((line) => {
      if (line === "git fetch --quiet origin") writeAutoUpdateEnabled(false);
    });
    const coordinator = createAgentSettledUpdateCoordinator(pi);
    const ctx = context();

    coordinator.onSessionStart(ctx);
    await coordinator.onAgentSettled(ctx);

    expect(calls).toEqual(CHECKOUT_UPDATE.slice(0, 6));
    expect(readAutoUpdateStatus()).toMatchObject({
      pending: false,
      lastResult: "skipped",
      restartRecommended: false,
      targets: expect.arrayContaining([
        expect.objectContaining({ target: "sf-omp-checkout", result: "skipped" }),
        expect.objectContaining({ target: "sf-cli", result: "skipped" }),
      ]),
    });
  });

  it("aborts a running target when a new agent turn starts and defers the remainder", async () => {
    writeAutoUpdateEnabled(true);
    const { pi, calls } = hangingPullPi();
    const coordinator = createAgentSettledUpdateCoordinator(pi);
    const ctx = context();

    coordinator.onSessionStart(ctx);
    const running = coordinator.onAgentSettled(ctx);
    await vi.waitFor(() => expect(calls).toContain(PULL));

    coordinator.onAgentStart();
    await running;

    expect(calls).toEqual(CHECKOUT_UPDATE.slice(0, 7));
    expect(readAutoUpdateStatus()).toMatchObject({ pending: true, running: false });
  });

  it("aborts running work on session shutdown without leaving it pending", async () => {
    writeAutoUpdateEnabled(true);
    const { pi, appendEntry, calls } = hangingPullPi();
    const coordinator = createAgentSettledUpdateCoordinator(pi);
    const ctx = context();

    coordinator.onSessionStart(ctx);
    const running = coordinator.onAgentSettled(ctx);
    await vi.waitFor(() => expect(calls).toContain(PULL));

    coordinator.onSessionShutdown();
    await running;

    expect(calls).toEqual(CHECKOUT_UPDATE.slice(0, 7));
    expect(readAutoUpdateStatus()).toMatchObject({ pending: false, running: false });
    expect(appendEntry.mock.calls.map(([, data]) => data.title)).toEqual(["Auto Update planned"]);
  });

  it("cancels pending work when the user revokes opt-in before settlement", async () => {
    writeAutoUpdateEnabled(true);
    const { pi, exec } = recordingPi();
    const coordinator = createAgentSettledUpdateCoordinator(pi);
    const ctx = context();

    coordinator.onSessionStart(ctx);
    writeAutoUpdateEnabled(false);
    await coordinator.onAgentSettled(ctx);

    expect(exec).not.toHaveBeenCalled();
    expect(readAutoUpdateStatus()).toMatchObject({
      pending: false,
      running: false,
      message: "Auto Update disabled before execution.",
    });
  });
});
