/* SPDX-License-Identifier: Apache-2.0 */
/** Manager action pages for SF Docs detail actions. */
import type { ExtensionTheme } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import type { ConfigPanelResult } from "../../../catalog/registry.ts";
import { matchesKey, type RowsPanel } from "../../../lib/common/ui-rows.ts";

interface PanelOptions {
  theme: Pick<ExtensionTheme, "fg" | "bold">;
  done: (result: ConfigPanelResult | undefined) => void;
  requestRender?: () => void;
}

interface ConnectOptions extends PanelOptions {
  prepareLogin: () => Promise<string> | string;
}

interface DisconnectOptions extends PanelOptions {
  endpointSourceLabel: string;
  disconnect: () => Promise<string> | string;
}

type ActionRows = RowsPanel & {
  renderContent(width: number): string[];
  handleInput(data: string): void;
};

export function createSfDocsConnectPanel(args: ConnectOptions): ActionRows {
  return new SfDocsConnectPanel(args);
}

export function createSfDocsDisconnectPanel(args: DisconnectOptions): ActionRows {
  return new SfDocsDisconnectPanel(args);
}

class SfDocsConnectPanel implements ActionRows {
  focused = false;
  private result = "";

  constructor(private readonly args: ConnectOptions) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.args.done(undefined);
      return;
    }
    if (matchesKey(data, "enter")) {
      if (this.result) {
        this.args.done(undefined);
        return;
      }
      void this.prepare();
    }
  }

  renderContent(width: number): string[] {
    const t = this.args.theme;
    if (this.result) {
      return [
        ` ${t.fg("accent", t.bold("Connect to SF Docs"))}`,
        "",
        ...wrap(this.result, Math.max(1, width - 3)).map((line) => ` ${t.fg("success", line)}`),
        "",
        ` ${t.fg("dim", "Enter/Esc back")}`,
      ];
    }

    const guidance = [
      "Native login collects a docs endpoint URL, then the access token in the host's masked prompt. The host stores both.",
      "SF_DOCS_MCP_TOKEN and SF_DOCS_MCP_ENDPOINT remain the automation and CI fallbacks.",
    ];
    return [
      ` ${t.fg("accent", t.bold("Connect to SF Docs"))}`,
      "",
      ...guidance.flatMap((text) =>
        wrap(text, Math.max(1, width - 3)).map((line) => ` ${t.fg("muted", line)}`),
      ),
      "",
      ` ${t.fg("accent", "→ Prepare native login")}`,
      "",
      ` ${t.fg("dim", "Enter prepare · Esc back")}`,
    ];
  }

  render(width: number): string[] {
    return this.renderContent(width);
  }

  private async prepare(): Promise<void> {
    this.result = await this.args.prepareLogin();
    this.args.requestRender?.();
  }
}

class SfDocsDisconnectPanel implements ActionRows {
  focused = false;
  private selected = 0;
  private result = "";

  constructor(private readonly args: DisconnectOptions) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.args.done(undefined);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.selected = this.selected === 0 ? 1 : 0;
      return;
    }
    if (matchesKey(data, "enter")) {
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
    if (this.result) {
      return [
        ` ${t.fg("accent", t.bold("Disconnect SF Docs"))}`,
        "",
        ...wrap(this.result, Math.max(1, width - 3)).map((line) => ` ${t.fg("success", line)}`),
        "",
        ` ${t.fg("dim", "Enter/Esc back")}`,
      ];
    }

    const confirm = this.selected === 0;
    return [
      ` ${t.fg("accent", t.bold("Disconnect SF Docs"))}`,
      ` ${t.fg("dim", "Prepare /logout sf-docs in OMP's editor for your review.")}`,
      ` ${t.fg("dim", "No credential changes occur until you submit it; environment variables are untouched.")}`,
      ` ${t.fg("muted", `Current source: ${this.args.endpointSourceLabel}`)}`,
      "",
      ` ${confirm ? t.fg("accent", "→") : " "} ${confirm ? t.fg("accent", "Prepare native logout") : t.fg("text", "Prepare native logout")}`,
      ` ${!confirm ? t.fg("accent", "→") : " "} ${!confirm ? t.fg("accent", "Cancel") : t.fg("text", "Cancel")}`,
      "",
      ` ${t.fg("dim", "↑/↓ choose · Enter prepare · Esc cancel")}`,
    ];
  }

  render(width: number): string[] {
    return this.renderContent(width);
  }

  private async confirm(): Promise<void> {
    this.result = await this.args.disconnect();
    this.args.requestRender?.();
  }
}
