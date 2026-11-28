/* SPDX-License-Identifier: Apache-2.0 */
/** Tests for SF Guardrail Manager settings panel interaction. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExtensionTheme as Theme,
  ExtensionUiHost,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PI_AGENT_ENV = "PI_CODING_AGENT_DIR";
const theme: Theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const host = {
  size: () => ({ rows: 40, columns: 120 }),
  requestRender: vi.fn(),
  suspend: (run) => run(),
} satisfies ExtensionUiHost;

let tmpDir: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = mkdtempSync(path.join(tmpdir(), "sf-guardrail-config-panel-"));
  prevAgentDir = process.env[PI_AGENT_ENV];
  process.env[PI_AGENT_ENV] = tmpDir;
});

afterEach(() => {
  if (prevAgentDir === undefined) delete process.env[PI_AGENT_ENV];
  else process.env[PI_AGENT_ENV] = prevAgentDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SF Guardrail config panel", () => {
  it("edits protected aliases with a native input page", async () => {
    const [{ createConfigPanel }, preferences] = await Promise.all([
      import("../lib/config-panel.ts"),
      import("../lib/preferences.ts"),
    ]);
    const panel = createConfigPanel(theme, "/tmp/project", "global", vi.fn(), host) as unknown as {
      handleInput(data: string): void;
      renderContent(width: number): string[];
    };

    // Move to Protected org aliases and open it.
    panel.handleInput("\u001b[B");
    panel.handleInput("\u001b[B");
    panel.handleInput("\u001b[B");
    panel.handleInput("\r");
    panel.handleInput("e");

    expect(panel.renderContent(120).join("\n")).toContain("Enter save aliases");
    for (const char of "Prod, FullCopy") panel.handleInput(char);
    panel.handleInput("\r");

    expect(
      preferences.productionAliasesText((await import("../lib/config.ts")).loadConfig().config),
    ).toBe("Prod, FullCopy");
    expect(panel.renderContent(120).join("\n")).toContain("Protected org aliases saved");
  });

  it("edits a live rule filter without leaving the page", async () => {
    // Load under the isolated agent directory, using the same boundary as Manager.
    const { createConfigPanel } = await import("../lib/config-panel.ts");
    const finish = vi.fn();
    const panel = createConfigPanel(theme, "/tmp/project", "global", finish, host);
    panel.focused = true;
    panel.handleInput?.("\r"); // File protection rules.
    panel.handleInput?.("\x1b[47u"); // Kitty '/'.
    panel.handleInput?.("does-not-exist");
    expect(panel.render(120).join("\n")).toContain("No matching rules.");
    panel.handleInput?.("\x1b[H");
    panel.handleInput?.("\x1b[120u"); // Kitty 'x' at the start of the query.
    // The focused field draws its caret with reverse video on the next glyph.
    expect(stripEscapes(panel.render(120).join("\n"))).toContain("Filter: xdoes-not-exist (0)");
    panel.handleInput?.("\r");
    expect(panel.capturesNavigation?.()).toBe(false);
    panel.handleInput?.("\x1b");
    expect(panel.render(120).join("\n")).toContain("Sections");
    expect(finish).not.toHaveBeenCalled();
    panel.dispose?.();
  });
});
