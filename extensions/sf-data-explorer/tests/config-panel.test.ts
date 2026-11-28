/* SPDX-License-Identifier: Apache-2.0 */
/** Tests for the SF Data Explorer Manager settings panel. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionTheme } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { RowsPanel } from "../../../lib/common/ui-rows.ts";
import { createConfigPanel } from "../lib/config-panel.ts";
import { readEffectiveDataExplorerSettings } from "../lib/settings.ts";

const tempDirs = new Set<string>();
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as ExtensionTheme;

type TestPanel = RowsPanel & {
  handleInput(data: string): void;
  renderContent(width: number): string[];
};

function tempCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-data-explorer-config-panel-"));
  tempDirs.add(dir);
  return dir;
}

function makePanel(cwd: string, done: (result: unknown) => void = vi.fn()): TestPanel {
  return createConfigPanel(theme, cwd, "project", done) as TestPanel;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe("Data Explorer config panel", () => {
  it("saves default mode in place", () => {
    const cwd = tempCwd();
    const done = vi.fn();
    const panel = makePanel(cwd, done);

    panel.handleInput("\x1b[C"); // soql -> sosl
    panel.handleInput("s");

    expect(done).not.toHaveBeenCalled();
    expect(readEffectiveDataExplorerSettings(cwd).defaultMode).toBe("sosl");
    expect(panel.renderContent(100).join("\n")).toContain("Saved Data Explorer settings.");
  });

  it("edits the default org with native paste and keeps Escape local to the field", () => {
    const cwd = tempCwd();
    const done = vi.fn();
    const panel = makePanel(cwd, done);

    panel.handleInput("\x1b[B");
    panel.handleInput("\r");
    panel.handleInput("x");
    panel.handleInput("\x1b");
    expect(done).not.toHaveBeenCalled();

    panel.handleInput("\r");
    panel.handleInput("\x1b[H");
    for (const _ of "default") panel.handleInput("\x1b[3~");
    panel.handleInput("\x1b[200~ExampleDev\x1b[201~");
    panel.handleInput("\r");
    panel.handleInput("s");
    expect(readEffectiveDataExplorerSettings(cwd).defaultOrg).toBe("ExampleDev");
    panel.dispose?.();
  });
});
