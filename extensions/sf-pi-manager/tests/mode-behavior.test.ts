/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Behavior tests for mode-aware manager surfaces.
 *
 * RPC mode has ctx.hasUI=true, but custom TUI components are not available.
 * Manager commands should therefore fall back to text/dialog behavior unless
 * ctx.mode === "tui".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sfPiManagerExtension from "../index.ts";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRpcContext(cwd: string) {
  return {
    cwd,
    mode: "rpc",
    hasUI: true,
    ui: {
      custom: vi.fn(async () => undefined),
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    reload: vi.fn(),
  };
}

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sf-pi manager mode behavior", () => {
  it("does not mount the manager custom overlay in RPC mode", async () => {
    const homeDir = makeTempDir("sf-pi-mode-home-");
    const projectDir = makeTempDir("sf-pi-mode-project-");
    process.env.HOME = homeDir;

    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const pi = {
      events: { on: vi.fn() },
      on: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerCommand: vi.fn((_name, definition) => {
        handler = definition.handler;
      }),
    };
    sfPiManagerExtension(pi as never);
    expect(handler).toBeDefined();

    const ctx = makeRpcContext(projectDir);
    await handler!("", ctx);

    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("sf-pi v"), "info");
  });
});
