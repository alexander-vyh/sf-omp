/* SPDX-License-Identifier: Apache-2.0 */
/** Mode-aware command output that never enters model context. */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionRows,
  ExtensionTheme,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { openInfoPanel, type InfoPanelSeverity } from "./info-panel.ts";
import { redactDisplayText } from "./redaction.ts";
import { nativeUi, textRows } from "./ui-rows.ts";

export interface HumanOnlyCommandOutput {
  title: string;
  body: string;
  severity: InfoPanelSeverity;
}

export function registerHumanOnlyCommandOutput(pi: ExtensionAPI, customType: string): void {
  const restore = (_event: unknown, ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    const entries = ctx.sessionManager.getBranch();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.type !== "custom" || entry.customType !== customType) continue;
      const data = entry.data;
      if (!data || typeof data !== "object" || !("title" in data) || !("body" in data)) continue;
      if (typeof data.title !== "string" || typeof data.body !== "string") continue;
      const output: HumanOnlyCommandOutput = {
        title: redactDisplayText(data.title),
        body: redactDisplayText(data.body),
        severity:
          "severity" in data &&
          (data.severity === "success" || data.severity === "warning" || data.severity === "error")
            ? data.severity
            : "info",
      };
      nativeUi(ctx.ui).setWidget(customType, (_ui, theme) =>
        createHumanOnlyCommandOutputRenderer()({ data: output }, { expanded: false }, theme),
      );
      return;
    }
    nativeUi(ctx.ui).setWidget(customType, undefined);
  };
  pi.on("session_start", restore);
  const native = pi as unknown as { on(event: "session_switch", handler: typeof restore): void };
  native.on("session_switch", restore);
  pi.on("session_tree", restore);
}

export function createHumanOnlyCommandOutputRenderer(): (
  entry: { data?: HumanOnlyCommandOutput },
  options: { expanded: boolean },
  theme: Pick<ExtensionTheme, "fg" | "bold">,
) => ExtensionRows {
  return (entry, _options, theme) => {
    const title = entry.data?.title ?? "Status";
    const body = entry.data?.body ?? title;
    const severity = entry.data?.severity ?? "info";
    const color =
      severity === "success"
        ? "success"
        : severity === "warning"
          ? "warning"
          : severity === "error"
            ? "error"
            : "accent";
    return textRows(`${theme.fg(color, theme.bold(title))}\n${theme.fg("text", body)}`);
  };
}

export async function emitHumanOnlyCommandOutput(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  customType: string,
  output: HumanOnlyCommandOutput,
): Promise<void> {
  const safeOutput: HumanOnlyCommandOutput = {
    title: redactDisplayText(output.title),
    body: redactDisplayText(output.body.trim() || output.title),
    severity: output.severity,
  };

  if (ctx.hasUI) {
    await openInfoPanel(ctx, safeOutput);
    return;
  }

  pi.appendEntry<HumanOnlyCommandOutput>(customType, safeOutput);
  if (ctx.mode === "print") console.info(safeOutput.body);
}
