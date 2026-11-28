/* SPDX-License-Identifier: Apache-2.0 */
/** OMP runtime adapter for the pure Instruction Surface Report module. */
import {
  buildInstructionSurfaceReport,
  type InstructionSurfaceContextMessage,
  type InstructionSurfaceReport,
  type InstructionSurfaceTool,
  type InstructionSurfaceUnavailable,
} from "./instruction-surface-report.ts";

export interface InstructionSurfaceRuntimePi {
  getAllTools(): InstructionSurfaceTool[];
  getActiveTools(): string[];
}

export interface InstructionSurfaceRuntimeContext {
  /** OMP returns the effective system prompt as ordered policy blocks. */
  getSystemPrompt(): string[];
  sessionManager: {
    getBranch(): unknown[];
  };
}

export interface CaptureInstructionSurfaceOptions {
  sfPiPackageRoot: string;
  sfPiToolNames: readonly string[];
  piRuntimeVersion?: string;
  sfPiVersion?: string;
  mode?: "current_session" | "bundled_baseline";
  supplementalContextMessages?: readonly InstructionSurfaceContextMessage[];
}

/** Surfaces OMP does not expose to extensions; reported, never estimated. */
export const OMP_UNAVAILABLE_SURFACES: readonly InstructionSurfaceUnavailable[] = [
  {
    surface: "skills",
    reason: "OMP exposes no skill list to extensions, so skill contributions are not measured.",
  },
  {
    surface: "tool_guidance",
    reason:
      "OMP tool metadata exposes neither prompt snippets nor prompt guidelines, so tool guidance is not measured.",
  },
];

export function captureInstructionSurfaceReport(
  pi: InstructionSurfaceRuntimePi,
  ctx: InstructionSurfaceRuntimeContext,
  options: CaptureInstructionSurfaceOptions,
): InstructionSurfaceReport {
  const tools = pi.getAllTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  return buildInstructionSurfaceReport({
    mode: options.mode ?? "current_session",
    // OMP joins policy blocks with a blank line when it sends the prompt.
    systemPrompt: ctx.getSystemPrompt().join("\n\n"),
    selectedTools: pi.getActiveTools(),
    tools,
    skills: [],
    unavailable: OMP_UNAVAILABLE_SURFACES,
    contextMessages: latestMessagesByType([
      ...(options.supplementalContextMessages ?? []),
      ...latestContextMessages(ctx.sessionManager.getBranch()),
    ]),
    sfPiToolNames: options.sfPiToolNames,
    sfPiPackageRoot: options.sfPiPackageRoot,
    externalSalesforceSkillRoots: [],
    piRuntimeVersion: options.piRuntimeVersion,
    sfPiVersion: options.sfPiVersion,
  });
}

function latestMessagesByType(
  messages: readonly InstructionSurfaceContextMessage[],
): InstructionSurfaceContextMessage[] {
  const latest = new Map<string, InstructionSurfaceContextMessage>();
  for (const message of messages) latest.set(message.customType, message);
  return [...latest.values()];
}

/** Latest model-visible custom message of each type on OMP's active session branch. */
function latestContextMessages(entries: readonly unknown[]): InstructionSurfaceContextMessage[] {
  const latest = new Map<string, InstructionSurfaceContextMessage>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as {
      type?: unknown;
      customType?: unknown;
      content?: unknown;
      excludeFromContext?: unknown;
    };
    if (
      candidate.type !== "custom_message" ||
      candidate.excludeFromContext === true ||
      typeof candidate.customType !== "string" ||
      (typeof candidate.content !== "string" && !Array.isArray(candidate.content))
    ) {
      continue;
    }
    latest.set(candidate.customType, {
      customType: candidate.customType,
      content: candidate.content as string | unknown[],
    });
  }
  return [...latest.values()];
}
