/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Manager confirm page for SF Fin install.
 *
 * Follows SF Code Analyzer's confirm panel, with one addition: the detail is
 * loaded asynchronously (install plan) before the user can confirm.
 */
import type { ExtensionTheme } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import type { ConfigPanelResult } from "../../../catalog/registry.ts";
import { matchesKey, type RowsPanel } from "../../../lib/common/ui-rows.ts";

type Done = (result: ConfigPanelResult | undefined) => void;

export interface ConfirmPanelDetail {
  detail: string;
  canConfirm: boolean;
  confirm?: () => Promise<string>;
}

export interface FinConfirmPanelArgs {
  theme: Pick<ExtensionTheme, "fg" | "bold">;
  title: string;
  confirmLabel: string;
  loadDetail: () => Promise<ConfirmPanelDetail>;
  done: Done;
  requestRender?: () => void;
}

export function createFinConfirmPanel(
  args: FinConfirmPanelArgs,
): RowsPanel & { renderContent(width: number): string[] } {
  return new FinConfirmPanel(args);
}

class FinConfirmPanel implements RowsPanel {
  focused = false;
  private selected = 0;
  private busy = true;
  private loaded?: ConfirmPanelDetail;
  private result = "";

  constructor(private readonly args: FinConfirmPanelArgs) {
    void this.load();
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.args.done(undefined);
      return;
    }
    if (this.loaded?.canConfirm && !this.result) {
      if (matchesKey(data, "up") || matchesKey(data, "down")) {
        this.selected = this.selected === 0 ? 1 : 0;
        return;
      }
    }
    if (matchesKey(data, "enter")) {
      if (this.result || !this.loaded?.canConfirm || this.selected === 1) {
        this.args.done(undefined);
        return;
      }
      void this.confirm();
    }
  }

  renderContent(width: number): string[] {
    const t = this.args.theme;
    const title = ` ${t.fg("accent", t.bold(this.args.title))}`;
    if (this.busy) return [title, "", ` ${t.fg("dim", this.loaded ? "Running…" : "Checking…")}`];
    if (this.result) {
      return [
        title,
        "",
        ...wrap(this.result, Math.max(1, width - 3)).map((line) => ` ${t.fg("text", line)}`),
        "",
        ` ${t.fg("dim", "Enter/Esc back")}`,
      ];
    }
    const body = wrap(this.loaded?.detail ?? "", Math.max(1, width - 3)).map(
      (line) => ` ${t.fg("dim", line)}`,
    );
    if (!this.loaded?.canConfirm)
      return [title, "", ...body, "", ` ${t.fg("dim", "Enter/Esc back")}`];
    const confirm = this.selected === 0;
    return [
      title,
      "",
      ...body,
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

  private async load(): Promise<void> {
    try {
      this.loaded = await this.args.loadDetail();
    } catch (error) {
      this.loaded = {
        detail: error instanceof Error ? error.message : String(error),
        canConfirm: false,
      };
    } finally {
      this.busy = false;
      this.args.requestRender?.();
    }
  }

  private async confirm(): Promise<void> {
    if (!this.loaded?.confirm) return;
    this.busy = true;
    try {
      this.result = await this.loaded.confirm();
    } catch (error) {
      this.result = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.args.requestRender?.();
    }
  }
}
