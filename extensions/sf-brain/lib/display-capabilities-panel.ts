/* SPDX-License-Identifier: Apache-2.0 */
/** Read-only SF Pi Manager panel for effective terminal display capabilities. */
import type { ExtensionTheme } from "@oh-my-pi/pi-coding-agent";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import type { ConfigPanelResult } from "../../../catalog/registry.ts";
import { decodeRowKey, type RowsPanel } from "../../../lib/common/ui-rows.ts";
import type { DisplayCapabilitiesReport } from "./display-capabilities.ts";

export function renderDisplayCapabilitiesReport(
  report: DisplayCapabilitiesReport,
  width = 100,
): string[] {
  const safeWidth = Number.isFinite(width) ? Math.max(20, Math.floor(width)) : 100;
  const lines = [
    "Display Capabilities",
    "Effective chat rendering state for this project and terminal.",
    "",
    `Mermaid mode        ${report.mermaidMode}`,
    `Status markers      ${report.glyphMode}`,
    `Terminal            ${report.terminalProgram}`,
    `Terminal columns    ${report.terminalColumns ?? "unknown"}`,
    "",
    "Native Mermaid forms",
    `  ${report.supportedMermaidForms.join(" · ")}`,
    "",
    "Terminal guidance",
    "  Use one top-level Mermaid fence with short labels.",
    "  Prefer TD/TB flowcharts and target about 80 columns.",
    "  Wide, warned, nested, or unsupported diagrams remain source.",
    "  Use tldraw for editable or durable Salesforce diagrams.",
  ];
  return lines.map((line) => truncate(line, safeWidth));
}

export class DisplayCapabilitiesPanel implements RowsPanel {
  focused = false;

  constructor(
    private readonly theme: ExtensionTheme,
    private readonly report: DisplayCapabilitiesReport,
    private readonly done: (result: ConfigPanelResult | undefined) => void,
  ) {}

  handleInput(data: string): void {
    const key = decodeRowKey(data);
    if (
      key?.kind !== "release" &&
      (key?.id === "escape" || key?.id === "enter" || key?.text === "q")
    ) {
      this.done(undefined);
    }
  }

  renderContent(width = 100): string[] {
    const lines = renderDisplayCapabilitiesReport(this.report, width);
    if (lines.length > 0) lines[0] = this.theme.fg("accent", this.theme.bold(lines[0] ?? ""));
    return [...lines, "", this.theme.fg("dim", "Enter/Esc back")];
  }

  render(width = 100): string[] {
    return this.renderContent(width);
  }
}
