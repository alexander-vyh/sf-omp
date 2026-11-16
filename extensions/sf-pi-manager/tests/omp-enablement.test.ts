/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Behavior proofs for the manager on the OMP host: no Pi settings.json package
 * entry exists, the overlay still opens, and enable/disable persist as
 * OMP-native `disabledExtensions` that apply on the next OMP start.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";
import sfPiManagerExtension from "../index.ts";

// vi.mock is hoisted above the imports, so the manager sees an OMP host.
vi.mock("../../../lib/common/pi-compat.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/common/pi-compat.ts")>()),
  isOmpHost: () => true,
}));

const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];
let agentDir = "";
let cwd = "";

function runtimeTestDir(prefix: string): string {
  const root = fileURLToPath(new URL("../../../.runtime/skill-tests/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, prefix));
  tempDirs.push(dir);
  return dir;
}

function loadCommand(): (args: string, ctx: unknown) => Promise<void> {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    events: { on: vi.fn(), emit: vi.fn() },
    on: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
      handler = definition.handler;
    }),
  };
  sfPiManagerExtension(pi as never);
  if (!handler) throw new Error("sf-pi command was not registered");
  return handler;
}

function makeContext(mode: "tui" | "rpc") {
  return {
    cwd,
    mode,
    hasUI: true,
    ui: {
      custom: vi.fn(async () => undefined),
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWorkingVisible: vi.fn(),
    },
    reload: vi.fn(),
  };
}

function disabledExtensions(): unknown {
  return (YAML.parse(readFileSync(path.join(agentDir, "config.yml"), "utf8")) ?? {})
    .disabledExtensions;
}

beforeEach(() => {
  const root = runtimeTestDir("sf-pi-manager-omp-");
  agentDir = path.join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = path.join(root, "home");
  cwd = mkdtempSync(path.join(tmpdir(), "sf-pi-manager-omp-cwd-"));
  tempDirs.push(cwd);
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sf-pi manager on the OMP host", () => {
  it("opens the Manager overlay without a Pi settings.json package entry", async () => {
    const ctx = makeContext("tui");
    await loadCommand()("", ctx);

    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("package not found"),
      expect.anything(),
    );
  });

  it("disables into OMP disabledExtensions and asks for a restart instead of reloading", async () => {
    const command = loadCommand();
    const ctx = makeContext("rpc");

    await command("disable sf-slack", ctx);

    expect(disabledExtensions()).toEqual(["extension-module:sf-slack"]);
    expect(ctx.reload).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/disabled in .*config\.yml\. Restart OMP to apply\./),
      "info",
    );

    await command("list", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringMatching(/○ SF Slack .*— disabled/),
      "info",
    );

    await command("enable sf-slack", ctx);
    expect(disabledExtensions()).toBeUndefined();
    expect(ctx.reload).not.toHaveBeenCalled();
  });

  it("refuses to disable the always-active manager", async () => {
    const ctx = makeContext("rpc");
    await loadCommand()("disable sf-pi-manager", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("always active"), "warning");
  });

  it("reports the OMP enablement config in status", async () => {
    const ctx = makeContext("rpc");
    await loadCommand()("status", ctx);

    const text = String(ctx.ui.notify.mock.calls.at(-1)?.[0]);
    expect(text).toContain("Host: OMP");
    expect(text).toContain(`Enablement config: ${path.join(agentDir, "config.yml")}`);
    expect(text).not.toContain("Package in settings: no");
  });

  it("reports every recommended package as unsupported with OMP coverage", async () => {
    const ctx = makeContext("tui");
    await loadCommand()("recommended", ctx);

    expect(ctx.ui.custom).not.toHaveBeenCalled();
    const text = String(ctx.ui.notify.mock.calls.at(-1)?.[0]);
    expect(text).toMatch(/Recommended extensions \(OMP host\): \d+ unsupported/);
    expect(text).toContain("explicit-only");
    expect(text).toContain("✗ pi-web-access (npm:pi-web-access)");
    expect(text).toContain("Under OMP: The bundled sf-herdr extension.");
  });

  it("refuses recommended install without running pi install", async () => {
    const ctx = makeContext("rpc");
    await loadCommand()("recommended install pi-web-access", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("/sf-pi recommended install is not supported under sf-omp."),
      "warning",
    );
    expect(ctx.reload).not.toHaveBeenCalled();
  });
});
