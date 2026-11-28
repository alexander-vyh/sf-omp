/* SPDX-License-Identifier: Apache-2.0 */
/** Manager action pages for SF Code Analyzer actions that need confirmation. */
import type { ExtensionTheme } from "@oh-my-pi/pi-coding-agent";
import type { ConfigPanelResult } from "../../../catalog/registry.ts";
import { decodeRowKey, type RowsPanel } from "../../../lib/common/ui-rows.ts";

type Done = (result: ConfigPanelResult | undefined) => void;

export function createCodeAnalyzerConfirmPanel(args: {
  theme: ExtensionTheme;
  title: string;
  detail: string;
  confirmLabel: string;
  onConfirm: () => Promise<string> | string;
  requestRender: () => void;
  done: Done;
}): RowsPanel & { renderContent(width: number): string[] } {
  return new CodeAnalyzerConfirmPanel(args);
}

class CodeAnalyzerConfirmPanel implements RowsPanel {
  focused = false;
  private selected = 0;
  private busy = false;
  private result = "";

  constructor(
    private readonly args: {
      theme: ExtensionTheme;
      title: string;
      detail: string;
      confirmLabel: string;
      onConfirm: () => Promise<string> | string;
      requestRender: () => void;
      done: Done;
    },
  ) {}

  handleInput(data: string): void {
    if (this.busy) return;
    const key = decodeRowKey(data);
    if (key?.kind === "release") return;
    const id = key?.id;
    if (id === "escape" || key?.text === "q") {
      this.args.done(undefined);
      return;
    }
    if (id === "up" || id === "down") {
      this.selected = this.selected === 0 ? 1 : 0;
      return;
    }
    if (id === "enter") {
      if (this.result) {
        this.args.done(undefined);
        return;
      }
      if (this.selected === 1) {
        this.args.done(undefined);
        return;
      }
      void this.confirm();
    }
  }

  renderContent(width: number): string[] {
    const t = this.args.theme;
    if (this.busy) {
      return [` ${t.fg("accent", t.bold(this.args.title))}`, "", ` ${t.fg("dim", "Running…")}`];
    }
    if (this.result) {
      return [
        ` ${t.fg("accent", t.bold(this.args.title))}`,
        "",
        ...wrap(this.result, width - 3).map((line) => ` ${t.fg("text", line)}`),
        "",
        ` ${t.fg("dim", "Enter/Esc back")}`,
      ];
    }
    const confirm = this.selected === 0;
    return [
      ` ${t.fg("accent", t.bold(this.args.title))}`,
      "",
      ...wrap(this.args.detail, width - 3).map((line) => ` ${t.fg("dim", line)}`),
      "",
      ` ${confirm ? t.fg("accent", "→") : " "} ${confirm ? t.fg("accent", this.args.confirmLabel) : t.fg("text", this.args.confirmLabel)}`,
      ` ${!confirm ? t.fg("accent", "→") : " "} ${!confirm ? t.fg("accent", "Cancel") : t.fg("text", "Cancel")}`,
      "",
      ` ${t.fg("dim", "↑/↓ choose · Enter confirm · Esc cancel")}`,
    ];
  }

  render(width: number): string[] {
    return this.renderContent(width);
  }

  private async confirm(): Promise<void> {
    this.busy = true;
    try {
      this.result = await this.args.onConfirm();
    } catch (error) {
      this.result = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.args.requestRender();
    }
  }
}

function wrap(text: string, width: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}
