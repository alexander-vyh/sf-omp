/* SPDX-License-Identifier: Apache-2.0 */
/** Human-facing SF Integrate Result Card rendering. */

import type {
  ExtensionRows,
  ExtensionTheme,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
  renderSfPiResultCardPanel,
  renderSfPiToolCallLine,
  type SfPiResultCard,
} from "../../../lib/common/display/result-card.ts";
import { textRows } from "../../../lib/common/ui-rows.ts";
import type { SfIntegrateParams, ToolResult } from "./types.ts";

type Theme = Pick<ExtensionTheme, "fg" | "bg" | "bold">;
type RenderResult = {
  content: readonly { type: string; text?: string }[];
  details?: ToolResult["details"];
};

export function renderIntegrationCall(args: SfIntegrateParams, theme: Theme): ExtensionRows {
  return textRows(
    renderSfPiToolCallLine(
      {
        icon: "🔗",
        label: "SF Integrate",
        action: args.action,
        subject: args.named_credential_name ?? args.app_name ?? args.mcp_preset,
        scope: args.target_org,
      },
      theme,
    ),
  );
}

export function renderIntegrationResult(
  result: RenderResult,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: Theme,
): ExtensionRows {
  if (options.isPartial) {
    return textRows(theme.fg("warning", "🔗 SF Integrate running…"));
  }
  const card = asCard(result.details?.card);
  if (!card) return textRows(result.content.find((part) => part.type === "text")?.text ?? "");
  return renderSfPiResultCardPanel(card, { expanded: options.expanded }, theme);
}

function asCard(value: unknown): SfPiResultCard | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<SfPiResultCard>;
  if (!candidate.tool || typeof candidate.title !== "string") return undefined;
  if (typeof candidate.summary !== "string" || typeof candidate.status !== "string") {
    return undefined;
  }
  return candidate as SfPiResultCard;
}
