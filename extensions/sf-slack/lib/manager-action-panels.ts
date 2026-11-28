/* SPDX-License-Identifier: Apache-2.0 */
/** Manager action pages for SF Slack detail actions. */
import type {
  ExtensionTheme,
  ExtensionUiHost,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import { decodeRowKey, type RowsPanel } from "../../../lib/common/ui-rows.ts";
import type { ConfigPanelResult } from "../../../catalog/registry.ts";

interface ActionPanelOptions {
  theme: ExtensionTheme;
  done: (result: ConfigPanelResult | undefined) => void;
  ui?: Pick<ExtensionUiHost, "requestRender">;
}

type ConnectPanelOptions = ActionPanelOptions & { prepareLogin: () => Promise<string> | string };
type DisconnectPanelOptions = ActionPanelOptions & {
  tokenSourceLabel: string;
  disconnect: () => Promise<string> | string;
};
type SlackActionPanel = RowsPanel & {
  handleInput(data: string): void;
  renderContent(width: number): string[];
};

export function createSlackConnectPanel(args: ConnectPanelOptions): SlackActionPanel {
  return new SlackConnectPanel(args);
}

export function createSlackDisconnectPanel(args: DisconnectPanelOptions): SlackActionPanel {
  return new SlackDisconnectPanel(args);
}

class SlackConnectPanel implements SlackActionPanel {
  focused = false;
  private result = "";

  constructor(private readonly args: ConnectPanelOptions) {}

  handleInput(data: string): void {
    const key = decodeRowKey(data);
    if (!key || key.kind === "release") return;
    if (key.id === "escape" || key.id === "q") {
      this.args.done(undefined);
      return;
    }
    if (key.id === "enter") {
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
        ` ${t.fg("accent", t.bold("Connect to Slack"))}`,
        "",
        ...wrap(this.result, Math.max(1, width - 3)).map((line) => ` ${t.fg("success", line)}`),
        "",
        ` ${t.fg("dim", "Enter/Esc back")}`,
      ];
    }

    const guidance = [
      "OMP masks credential entry and owns credential persistence.",
      "Existing saved credentials remain active. SLACK_USER_TOKEN remains the automation and CI fallback.",
      "After login, run /sf-slack refresh to verify identity, scopes, and tool availability.",
    ];
    return [
      ` ${t.fg("accent", t.bold("Connect to Slack"))}`,
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
    this.args.ui?.requestRender();
  }
}

class SlackDisconnectPanel implements SlackActionPanel {
  focused = false;
  private selected = 0;
  private result = "";

  constructor(private readonly args: DisconnectPanelOptions) {}

  handleInput(data: string): void {
    const key = decodeRowKey(data);
    if (!key || key.kind === "release") return;
    if (key.id === "escape" || key.id === "q") {
      this.args.done(undefined);
      return;
    }
    if (key.id === "up" || key.id === "down") {
      this.selected = this.selected === 0 ? 1 : 0;
      return;
    }
    if (key.id === "enter") {
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
        ` ${t.fg("accent", t.bold("Disconnect Slack"))}`,
        "",
        ...wrap(this.result, Math.max(1, width - 3)).map((line) => ` ${t.fg("success", line)}`),
        "",
        ` ${t.fg("dim", "Enter/Esc back")}`,
      ];
    }
    const confirm = this.selected === 0;
    return [
      ` ${t.fg("accent", t.bold("Disconnect Slack"))}`,
      ` ${t.fg("dim", "Prepare /logout sf-slack in Pi's editor for your review.")}`,
      ` ${t.fg("dim", "No credential changes until you submit it; SLACK_USER_TOKEN is untouched.")}`,
      ` ${t.fg("muted", `Current source: ${this.args.tokenSourceLabel}`)}`,
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
    this.args.ui?.requestRender();
  }
}
