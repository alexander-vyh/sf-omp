/* SPDX-License-Identifier: Apache-2.0 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  handleAutoUpdate,
  runNativeAutoUpdate,
  parseAutoUpdateArgs,
} from "../lib/auto-update-command.ts";
import type * as WindowsSpawn from "../../../lib/common/windows-spawn.ts";
import { CHECKOUT_UPDATE, fakeExec as fakeCheckoutExec, type ExecResult } from "./checkout-exec.ts";

// Exec expectations below use bare command names; Windows command resolution
// is covered by lib/common/tests/windows-spawn.test.ts and the native OMP proof.
vi.mock("../../../lib/common/windows-spawn.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof WindowsSpawn>()),
  spawnCommand: (name: string, args: readonly string[]) => [name, [...args]],
}));

const PI_AGENT_ENV = "PI_CODING_AGENT_DIR";

let tmpDir: string;
let prevAgent: string | undefined;

function fakeExec(overrides?: Record<string, Partial<ExecResult>>) {
  const { exec, calls } = fakeCheckoutExec(overrides);
  return { pi: { exec } as unknown as ExtensionAPI, calls };
}

function runContext(hasUI = false) {
  return {
    cwd: tmpDir,
    hasUI,
    ui: { setStatus: vi.fn() },
  } as unknown as Pick<ExtensionContext, "cwd" | "ui" | "hasUI">;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "sf-pi-auto-update-command-"));
  mkdirSync(tmpDir, { recursive: true });
  prevAgent = process.env[PI_AGENT_ENV];
  process.env[PI_AGENT_ENV] = tmpDir;
});

afterEach(() => {
  if (prevAgent === undefined) delete process.env[PI_AGENT_ENV];
  else process.env[PI_AGENT_ENV] = prevAgent;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Native Auto Update command", () => {
  it("parses actions", () => {
    expect(parseAutoUpdateArgs("run")).toEqual({ action: "run" });
    expect(parseAutoUpdateArgs("on")).toEqual({ action: "on" });
    expect(parseAutoUpdateArgs("")).toEqual({ action: "status" });
  });

  it("delegates an explicit run through the shared coordinator", async () => {
    const status = {
      lastResult: "success" as const,
      message: "done",
      restartRecommended: true,
    };
    const runner = { runManual: vi.fn(async () => status) };
    const notify = vi.fn();
    const ctx = {
      cwd: tmpDir,
      hasUI: true,
      isIdle: () => true,
      ui: { setStatus: vi.fn(), notify },
    } as unknown as ExtensionContext;

    await handleAutoUpdate({} as ExtensionAPI, ctx as never, { action: "run" }, runner);

    expect(runner.runManual).toHaveBeenCalledWith(ctx);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("done"), "info");
  });

  it("fast-forwards the sf-omp checkout and updates Salesforce CLI, never the OMP runtime", async () => {
    const { pi, calls } = fakeExec();

    const status = await runNativeAutoUpdate(pi, runContext(true), {
      checkoutRoot: tmpDir,
      env: {},
    });

    expect(calls).toEqual([...CHECKOUT_UPDATE, "sf update stable"]);
    expect(calls.filter((call) => /^(?:omp|pi) /.test(call))).toEqual([]);
    expect(status.targets?.map((target) => [target.target, target.result])).toEqual([
      ["pi-runtime", "skipped"],
      ["sf-omp-checkout", "success"],
      ["sf-cli", "success"],
    ]);
    expect(status).toMatchObject({ lastResult: "success", restartRecommended: true });
    expect(status.message).toContain("updated separately with `omp update`");
  });

  it("respects PI_OFFLINE without starting network update commands", async () => {
    const pi = { exec: vi.fn() } as unknown as ExtensionAPI;

    const status = await runNativeAutoUpdate(pi, runContext(), { env: { PI_OFFLINE: "1" } });

    expect(pi.exec).not.toHaveBeenCalled();
    expect(status).toMatchObject({ lastResult: "skipped", restartRecommended: false });
    expect(status.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "sf-omp-checkout", result: "skipped" }),
        expect.objectContaining({ target: "sf-cli", result: "skipped" }),
      ]),
    );
  });

  it("leaves a dirty checkout untouched and still updates Salesforce CLI", async () => {
    const { pi, calls } = fakeExec({
      "git status --porcelain --untracked-files=no": { stdout: " M README.md" },
    });

    const status = await runNativeAutoUpdate(pi, runContext(), { checkoutRoot: tmpDir, env: {} });

    expect(calls).toEqual([...CHECKOUT_UPDATE.slice(0, 6), "sf update stable"]);
    expect(status.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "sf-omp-checkout",
          result: "skipped",
          message: expect.stringContaining("local changes"),
        }),
        expect.objectContaining({ target: "sf-cli", result: "success" }),
      ]),
    );
    expect(status).toMatchObject({ lastResult: "success", restartRecommended: false });
  });

  it("recommends restart when the checkout moved but npm ci failed", async () => {
    const { pi, calls } = fakeExec({ "npm ci": { code: 1 } });

    const status = await runNativeAutoUpdate(pi, runContext(), { checkoutRoot: tmpDir, env: {} });

    expect(calls).toEqual([...CHECKOUT_UPDATE, "sf update stable"]);
    expect(status).toMatchObject({ lastResult: "failed", restartRecommended: true });
    expect(status.targets).toContainEqual(
      expect.objectContaining({
        target: "sf-omp-checkout",
        result: "failed",
        message: expect.stringContaining("npm ci failed"),
      }),
    );
  });

  it("continues to Salesforce CLI when the fetch fails and persists no raw output", async () => {
    const { pi, calls } = fakeExec({
      "git fetch --quiet origin": {
        code: 1,
        stderr: "api_key=secret-value https://private.example.test /Users/private/home",
      },
    });

    const status = await runNativeAutoUpdate(pi, runContext(), { checkoutRoot: tmpDir, env: {} });

    expect(calls).toEqual([...CHECKOUT_UPDATE.slice(0, 4), "sf update stable"]);
    expect(status.lastResult).toBe("failed");
    expect(status.targets).toContainEqual(
      expect.objectContaining({
        target: "sf-omp-checkout",
        result: "failed",
        message: "Could not fetch origin; the checkout was left unchanged.",
      }),
    );
    expect(JSON.stringify(status)).not.toContain("secret-value");
    expect(JSON.stringify(status)).not.toContain("private.example.test");
    expect(JSON.stringify(status)).not.toContain("/Users/private/home");
  });
});
