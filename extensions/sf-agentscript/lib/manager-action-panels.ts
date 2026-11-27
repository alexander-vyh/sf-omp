/* SPDX-License-Identifier: Apache-2.0 */
/** Manager action pages for SF Agent Script commands that need one input. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionTheme } from "@oh-my-pi/pi-coding-agent";
import type { ConfigPanelResult } from "../../../catalog/registry.ts";
import { RowsTextField } from "../../../lib/common/ui-field.ts";
import { matchesKey, type RowsPanel } from "../../../lib/common/ui-rows.ts";

type Done = (result: ConfigPanelResult | undefined) => void;

export function createAgentScriptInputActionPanel(args: {
  theme: ExtensionTheme;
  title: string;
  help: string;
  placeholder: string;
  done: Done;
  run: (value: string) => Promise<void> | void;
}): RowsPanel & { renderContent(width: number): string[] } {
  return new AgentScriptInputActionPanel(args);
}

class AgentScriptInputActionPanel implements RowsPanel {
  private readonly input = new RowsTextField();
  private error = "";

  get focused(): boolean {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }

  constructor(
    private readonly args: {
      theme: ExtensionTheme;
      title: string;
      help: string;
      placeholder: string;
      done: Done;
      run: (value: string) => Promise<void> | void;
    },
  ) {
    this.input.setValue(args.placeholder);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.args.done(undefined);
      return;
    }
    if (matchesKey(data, "enter")) {
      this.submit(this.input.getValue());
      return;
    }
    this.input.handleInput(data);
  }

  renderContent(width: number): string[] {
    const t = this.args.theme;
    return [
      ` ${t.fg("accent", t.bold(this.args.title))}`,
      ` ${t.fg("dim", this.args.help)}`,
      "",
      ...this.input.render(Math.max(20, width - 4)).map((line) => ` ${line}`),
      this.error ? ` ${t.fg("error", this.error)}` : "",
      "",
      ` ${t.fg("dim", "Enter run · Esc back")}`,
    ].filter((line) => line !== "");
  }

  render(width: number): string[] {
    return this.renderContent(width);
  }

  capturesNavigation(): boolean {
    return true;
  }

  dispose(): void {
    this.input.dispose();
  }

  private submit(value: string): void {
    const trimmed = value.trim();
    if (!trimmed || trimmed === this.args.placeholder) {
      this.error = "Enter a value before running.";
      return;
    }
    this.args.done(undefined);
    setTimeout(() => {
      void this.args.run(trimmed);
    }, 0);
  }
}

export function runAgentScriptInputAfterClose(
  ctx: ExtensionCommandContext,
  run: () => Promise<void> | void,
): void {
  setTimeout(() => {
    if (!ctx.signal?.aborted) void run();
  }, 0);
}
