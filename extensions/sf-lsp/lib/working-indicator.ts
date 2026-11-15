/* SPDX-License-Identifier: Apache-2.0 */
/**
 * LSP-aware working indicator helper.
 *
 * Uses OMP's working message while diagnostics run, preserving its native
 * spinner and restoring the default message when all checks complete.
 *
 * We reference-count nested pushes because parallel tool execution can have
 * multiple supported files in flight at once. Only when the count drops to
 * zero do we restore the default indicator.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SupportedLanguage } from "./types.ts";
import { languageLabel } from "./activity.ts";

interface WorkingIndicatorState {
  depth: number;
  active?: SupportedLanguage;
}

export function createWorkingIndicatorState(): WorkingIndicatorState {
  return { depth: 0 };
}

export function pushLspIndicator(
  ctx: ExtensionContext,
  state: WorkingIndicatorState,
  language: SupportedLanguage,
): void {
  if (!ctx.hasUI) return;
  state.depth += 1;
  state.active = language;

  ctx.ui.setWorkingMessage(`LSP ${languageLabel(language)}…`);
}

export function popLspIndicator(ctx: ExtensionContext, state: WorkingIndicatorState): void {
  if (!ctx.hasUI) return;
  state.depth = Math.max(0, state.depth - 1);
  if (state.depth === 0) {
    state.active = undefined;
    ctx.ui.setWorkingMessage();
  }
}

/** Force-reset to the default indicator (e.g. on session_shutdown). */
export function resetLspIndicator(ctx: ExtensionContext, state: WorkingIndicatorState): void {
  state.depth = 0;
  state.active = undefined;
  if (!ctx.hasUI) return;
  ctx.ui.setWorkingMessage();
}
