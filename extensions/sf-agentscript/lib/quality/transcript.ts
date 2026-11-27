/* SPDX-License-Identifier: Apache-2.0 */
/** Human-only quality widgets, restored from durable branch entries on navigation. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionRows, ExtensionTheme } from "@oh-my-pi/pi-coding-agent";
import { nativeUi, textRows } from "../../../../lib/common/ui-rows.ts";
import { AGENT_SCRIPT_QUALITY_ENTRY_TYPE } from "./auto-scan.ts";
import {
  createQualityCardComponent,
  qualityCardData,
  type AgentScriptQualityCardData,
} from "./presentation.ts";
import type { AgentScriptQualityResult } from "./types.ts";

interface LegacyAgentScriptQualityTranscriptEntry {
  content?: string;
  details?: {
    status?: string;
    file?: string;
    summary?: AgentScriptQualityResult["summary"];
    findings?: AgentScriptQualityResult["findings"];
    coverage?: AgentScriptQualityResult["coverage"];
    metrics?: AgentScriptQualityResult["metrics"];
    suppressions?: AgentScriptQualityResult["suppressions"];
    failure_reason?: string;
  };
}

type AgentScriptQualityTranscriptEntry =
  AgentScriptQualityCardData | LegacyAgentScriptQualityTranscriptEntry;

export function registerAgentScriptQualityTranscriptRenderer(pi: ExtensionAPI): void {
  const restore = (_event: unknown, ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    const ui = nativeUi(ctx.ui);
    const entries = ctx.sessionManager.getBranch();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.type !== "custom" || entry.customType !== AGENT_SCRIPT_QUALITY_ENTRY_TYPE) continue;
      const card = normalizeCard(entry.data as AgentScriptQualityTranscriptEntry | undefined);
      if (!card) continue;
      ui.setWidget(AGENT_SCRIPT_QUALITY_ENTRY_TYPE, (_ui, theme) =>
        createQualityCardComponent(card, false, theme),
      );
      return;
    }
    ui.setWidget(AGENT_SCRIPT_QUALITY_ENTRY_TYPE, undefined);
  };
  pi.on("session_start", restore);
  const native = pi as unknown as { on(event: "session_switch", handler: typeof restore): void };
  native.on("session_switch", restore);
  pi.on("session_tree", restore);
}

export function createAgentScriptQualityTranscriptRenderer(): (
  entry: { data?: AgentScriptQualityTranscriptEntry },
  options: { expanded: boolean },
  theme: ExtensionTheme,
) => ExtensionRows {
  return (entry, options, theme) => {
    const card = normalizeCard(entry.data);
    return card
      ? createQualityCardComponent(card, options.expanded, theme)
      : textRows(theme.fg("dim", "Agent Script quality"));
  };
}

function normalizeCard(data: AgentScriptQualityTranscriptEntry | undefined) {
  if (!data) return undefined;
  if ("schema_version" in data && data.schema_version === 1) return data;
  const details = "details" in data ? data.details : undefined;
  if (!details?.summary || !details.coverage || !details.metrics) return undefined;
  const quality: AgentScriptQualityResult = {
    ok: details.status !== "failed",
    status:
      details.status === "clean" ||
      details.status === "findings" ||
      details.status === "partial" ||
      details.status === "failed"
        ? details.status
        : "findings",
    findings: details.findings ?? [],
    summary: details.summary,
    coverage: details.coverage,
    metrics: details.metrics,
    suppressions: details.suppressions ?? { applied: [], invalid: [], unused: [] },
    ...(details.failure_reason ? { failure_reason: details.failure_reason } : {}),
  };
  return qualityCardData(details.file ?? "Agent.agent", quality, {
    ...(details.status === "stopped" ? { state: "stopped" as const } : {}),
  });
}
