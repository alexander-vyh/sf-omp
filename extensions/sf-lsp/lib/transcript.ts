/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Human-only evidence for sf-lsp checks.
 *
 * Custom entries retain the diagnostic history without model-visible messages.
 * OMP widgets present the latest check; diagnostic previews are always visible.
 * The tool-result feedback remains the model-facing diagnostics channel.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionTheme } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { nativeUi, textRows } from "../../../lib/common/ui-rows.ts";
import { languageLongLabel, statusColor, type LspActivityStatus } from "./activity.ts";
import type { SupportedLanguage } from "./types.ts";

export const LSP_TRANSCRIPT_CUSTOM_TYPE = "sf-lsp";

const presentationContexts = new WeakMap<ExtensionAPI, ExtensionContext>();

export function registerLspTranscriptPresentation(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    presentationContexts.set(pi, ctx);
    if (ctx.hasUI) nativeUi(ctx.ui).setWidget(LSP_TRANSCRIPT_CUSTOM_TYPE, undefined);
  });
  pi.on("session_shutdown", () => {
    presentationContexts.delete(pi);
  });
}

export interface LspTranscriptDetails {
  language: SupportedLanguage;
  fileName: string;
  status: LspActivityStatus;
  diagnosticCount: number;
  durationMs?: number;
  unavailableReason?: string;
  previewLines?: string[];
}

export interface LspTranscriptEntry {
  content: string;
  details: LspTranscriptDetails;
}

export type VerbosityMode = "balanced" | "verbose";

/**
 * Decide whether to send a transcript row for this sample under the
 * current verbosity setting.
 *
 * balanced: emit on error + transition-clean + unavailable (first time)
 * verbose : emit on every check
 */
export function shouldEmitTranscriptRow(
  status: LspActivityStatus,
  mode: VerbosityMode,
  previousUnavailableSeen: boolean,
): boolean {
  if (mode === "verbose") return true;
  if (status === "error") return true;
  if (status === "transition-clean") return true;
  if (status === "unavailable" && !previousUnavailableSeen) return true;
  return false;
}

export function emitTranscriptRow(pi: ExtensionAPI, details: LspTranscriptDetails): void {
  const entry = { content: buildPlainContent(details), details };
  pi.appendEntry<LspTranscriptEntry>(LSP_TRANSCRIPT_CUSTOM_TYPE, entry);
  const ctx = presentationContexts.get(pi);
  if (ctx?.hasUI) {
    nativeUi(ctx.ui).setWidget(LSP_TRANSCRIPT_CUSTOM_TYPE, (_ui, theme) =>
      createTranscriptRenderer()({ data: entry }, { expanded: true }, theme),
    );
  }
}

function buildPlainContent(details: LspTranscriptDetails): string {
  const language = languageLongLabel(details.language);
  switch (details.status) {
    case "error":
      return `${language} · ${details.fileName} · ${details.diagnosticCount} error${
        details.diagnosticCount === 1 ? "" : "s"
      }`;
    case "clean":
    case "transition-clean":
      return `${language} · ${details.fileName} · clean`;
    case "unavailable":
      return `${language} · LSP unavailable`;
    case "checking":
      return `${language} · checking ${details.fileName}`;
    case "idle":
    default:
      return `${language} · ${details.fileName}`;
  }
}

/** Styled rows for the human-only diagnostic widget. */
export function createTranscriptRenderer() {
  return (
    entry: { data?: LspTranscriptEntry },
    options: { expanded: boolean },
    theme: ExtensionTheme,
  ) => {
    const details = entry.data?.details;
    const status = details?.status ?? "idle";
    const color = statusColor(status);
    const plainContent = entry.data?.content ?? "";

    const parts: string[] = [];
    parts.push(theme.fg(color, "[sf-lsp]"));
    parts.push(theme.fg("text", plainContent));

    if (details?.durationMs !== undefined) {
      parts.push(theme.fg("dim", `· ${formatDurationForRow(details.durationMs)}`));
    }

    let text = parts.join(" ");

    if (options.expanded) {
      text += renderExpandedBody(details, theme);
    } else if (details?.status === "error" && details.diagnosticCount > 0) {
      text += theme.fg("dim", "\n  ▸ ctrl+e to expand");
    }

    const rows = textRows(text, 1);
    return {
      render: (width: number) => rows.render(width).map((row) => theme.bg("customMessageBg", row)),
    };
  };
}

function formatDurationForRow(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderExpandedBody(
  details: LspTranscriptDetails | undefined,
  theme: ExtensionTheme,
): string {
  if (!details) return "";
  const lines: string[] = [];

  if (details.status === "error" && details.previewLines?.length) {
    for (const line of details.previewLines) {
      lines.push(`\n${theme.fg("error", "  ")}${theme.fg("text", line)}`);
    }
  }

  if (details.status === "unavailable" && details.unavailableReason) {
    lines.push(`\n${theme.fg("warning", `  ${details.unavailableReason}`)}`);
  }

  return lines.join("");
}
