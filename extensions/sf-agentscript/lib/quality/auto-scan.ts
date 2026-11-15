/* SPDX-License-Identifier: Apache-2.0 */
/** Native OMP stop-boundary Agent Script quality pass and bounded repair loop. */
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { getAgentScriptAnalysis } from "../analysis-snapshot.ts";
import { isAgentScriptFile, resolveToolPath } from "../file-classify.ts";
import { readEffectiveAgentScriptQualitySettings } from "./settings.ts";
import {
  createQualityCardComponent,
  buildQualityRepairPayload,
  qualityCardData,
} from "./presentation.ts";
import type { AgentScriptQualityFinding, AgentScriptQualityResult } from "./types.ts";

export const AGENT_SCRIPT_QUALITY_ENTRY_TYPE = "sf-agentscript-quality";

interface QualitySettingsLike {
  autoRun: boolean;
}

export interface DeferredAgentScriptQualityDeps {
  readSettings?: () => QualitySettingsLike;
  runQualityFile?: (file: string) => Promise<AgentScriptQualityResult>;
}

interface QualityStopEvent {
  signal: AbortSignal;
}

interface QualityStopResult {
  continue: true;
  additionalContext: string;
}

type QualityStopAPI = ExtensionAPI & {
  on(
    event: "session_stop",
    handler: (
      event: QualityStopEvent,
      ctx: ExtensionContext,
    ) => Promise<QualityStopResult | undefined>,
  ): void;
};

export function registerDeferredAgentScriptQuality(
  pi: ExtensionAPI,
  deps: DeferredAgentScriptQualityDeps = {},
): void {
  const pending = new Set<string>();
  const signatures = new Map<string, string>();
  const attempts = new Map<string, number>();
  const readSettings = deps.readSettings ?? readEffectiveAgentScriptQualitySettings;
  const runQualityFile = deps.runQualityFile ?? runFile;

  pi.on("tool_result", async (event, ctx) => {
    collectFile(event, ctx, pending);
  });

  // Pi's published SDK types predate OMP's native stop hook.
  const nativePi = pi as QualityStopAPI;
  nativePi.on("session_stop", async (event, ctx) => {
    if (event.signal.aborted || pending.size === 0) return;
    if (!readSettings().autoRun) {
      pending.clear();
      return;
    }

    const files = [...pending].sort();
    const repairs: string[] = [];
    const results: Array<{ file: string; quality: AgentScriptQualityResult }> = [];
    for (const file of files) {
      if (event.signal.aborted) return;
      results.push({ file, quality: await runQualityFile(file) });
    }
    if (event.signal.aborted) return;
    for (const file of files) pending.delete(file);
    for (const { file, quality } of results) {
      const actionable = quality.findings.filter(
        (finding) => finding.severity === "high" || finding.severity === "moderate",
      );
      const signature = findingSignature(actionable);
      const priorAttempt = attempts.get(file) ?? 0;

      if (!quality.ok || quality.status === "failed" || actionable.length === 0) {
        emitQualityCard(pi, ctx, file, quality, {
          ...(quality.status === "clean" && priorAttempt > 0
            ? {
                state: "fixed" as const,
                repair: { attempt: priorAttempt, signature: signatures.get(file) ?? "" },
              }
            : {}),
        });
        signatures.delete(file);
        attempts.delete(file);
        continue;
      }

      if (signatures.get(file) === signature) {
        emitQualityCard(pi, ctx, file, quality, {
          state: "stopped",
          repair: { attempt: Math.max(1, priorAttempt), signature },
          message: "No further automatic repair was scheduled.",
        });
        continue;
      }

      const attempt = priorAttempt + 1;
      signatures.set(file, signature);
      attempts.set(file, attempt);
      emitQualityCard(pi, ctx, file, quality, {
        state: "repairing",
        repair: { attempt, signature },
      });
      const payload = buildQualityRepairPayload(file, actionable, attempt, signature);
      repairs.push(JSON.stringify(payload));
    }

    if (repairs.length === 0) return;
    return { continue: true, additionalContext: repairs.join("\n\n") };
  });

  pi.on("session_shutdown", () => {
    pending.clear();
    signatures.clear();
    attempts.clear();
  });
}

function collectFile(event: ToolResultEvent, ctx: ExtensionContext, pending: Set<string>): void {
  if (event.isError || (!isEditToolResult(event) && !isWriteToolResult(event))) return;
  const rawPath = event.input?.path;
  if (typeof rawPath !== "string" || rawPath.trim() === "") return;
  const file = resolveToolPath(rawPath, ctx.cwd);
  if (isAgentScriptFile(file)) pending.add(file);
}

async function runFile(file: string): Promise<AgentScriptQualityResult> {
  return (await getAgentScriptAnalysis(file)).getQuality();
}

function emitQualityCard(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  file: string,
  quality: AgentScriptQualityResult,
  options: Parameters<typeof qualityCardData>[2] = {},
): void {
  const card = qualityCardData(file, quality, options);
  pi.appendEntry(AGENT_SCRIPT_QUALITY_ENTRY_TYPE, card);
  if (ctx.mode === "tui") {
    ctx.ui.setWidget(AGENT_SCRIPT_QUALITY_ENTRY_TYPE, (_tui, theme) =>
      createQualityCardComponent(card, false, theme),
    );
  }
}

function findingSignature(findings: AgentScriptQualityFinding[]): string {
  return findings
    .map((finding) => `${finding.rule_id}:${finding.line}:${finding.message}`)
    .sort()
    .join("|");
}
