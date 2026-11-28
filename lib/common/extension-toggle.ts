/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Shared "toggle this extension" action used by every per-extension
 * command panel.
 *
 * Why this lives in lib/common:
 * - 11 of 13 bundled extensions consume this helper from their own
 *   command panels. Once a helper crosses two consumers it belongs in
 *   lib/common, not inside another extension.
 * - The WRITE-side state logic lives next to it in
 *   ./omp-extension-state.ts. Together they form the small "manager
 *   surface" that any extension can call to disable or re-enable
 *   itself.
 *
 * Public surface:
 * - {@link buildToggleExtensionAction}: returns a `CommandPanelAction`
 *   row labeled "Disable this extension" / "Enable this extension"
 *   depending on the current state. Returns `null` for `alwaysActive`
 *   extensions so callers can spread the result into an actions array
 *   without an extra branch.
 * - {@link performToggleExtension}: flips the extension's entry in
 *   OMP-native `disabledExtensions` YAML (project > global, see
 *   ./omp-extension-state.ts) and notifies the user; the change applies on
 *   the next OMP start.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SF_PI_REGISTRY } from "../../catalog/registry.ts";
import { isExtensionDisabledInOmpConfig } from "./sf-pi-extension-state.ts";
import {
  readOmpDisabledExtensionFiles,
  resolveOmpConfigScope,
  writeOmpDisabledExtensionFiles,
} from "./omp-extension-state.ts";
import type { CommandPanelAction } from "./command-panel.ts";

/**
 * Stable group label used by every panel that adopts the shared toggle
 * action. Exported so individual extensions can also place a "Close"
 * action in the same group for visual consistency.
 */
export const LIFECYCLE_GROUP = "Lifecycle";

/**
 * The lifecycle action ids reserved by this helper. Extensions should not
 * reuse these values for unrelated actions, or the toggle wiring breaks.
 */
export type LifecycleActionId = "lifecycle.toggle";

/**
 * Predicate for `CommandPanelOptions.closeBeforeAction`.
 *
 * Every panel that wires `lifecycle.toggle` to {@link performToggleExtension}
 * passes this as `closeBeforeAction`, so the toggle runs after the panel has
 * closed instead of leaving a panel whose toggle row no longer matches the
 * OMP config.
 *
 * Generic in `A` so TypeScript still infers each panel's narrow action
 * union from `onAction` instead of widening the inferred `T` to `string`
 * via this predicate's parameter type. (We tried a non-generic
 * `(action: string)` signature first — it caused TS2345 "Argument of type
 * 'string' is not assignable to parameter of type 'WelcomeAction'" inside
 * the panel's `onAction` because T was unified upward to `string`.)
 */
export function isLifecycleToggleAction<A extends string>(action: A): boolean {
  return action === "lifecycle.toggle";
}

export interface BuildToggleActionOptions {
  /** sf-pi extension id, e.g. "sf-data360". */
  extensionId: string;
  /** Resolves the cwd at action build time. Pass `() => ctx.cwd`. */
  cwd: string;
}

/**
 * Build the toggle action row, or return `null` when the extension is
 * `alwaysActive` (sf-pi-manager, sf-brain) and therefore cannot be
 * toggled at all. Callers are expected to treat `null` as "skip this row".
 */
export function buildToggleExtensionAction(
  options: BuildToggleActionOptions,
): CommandPanelAction<LifecycleActionId> | null {
  const ext = SF_PI_REGISTRY.find((e) => e.id === options.extensionId);
  if (!ext) return null;
  if (ext.alwaysActive) return null;

  const enabled = !isExtensionDisabledInOmpConfig(ext.id, options.cwd);
  return {
    value: "lifecycle.toggle",
    label: enabled ? "Disable this extension" : "Enable this extension",
    description: enabled
      ? `Add an exclusion for ${ext.id} to your OMP config and restart OMP. Re-enable later with /sf-pi enable ${ext.id}.`
      : `Remove the exclusion for ${ext.id} from your OMP config and restart OMP so its tools, skills, and commands return.`,
    group: LIFECYCLE_GROUP,
  };
}

/**
 * Flip the given extension's entry in OMP-native `disabledExtensions` YAML
 * (project > global) and notify the user. OMP never rebinds extension
 * factories on `ctx.reload()`; the `requirePiVersion()` gate applies the
 * change on the next OMP start.
 *
 * `alwaysActive` extensions are a no-op; we surface a warning so panels
 * that incorrectly forward the toggle still produce a clear message
 * instead of silently doing nothing.
 */
export async function performToggleExtension(
  ctx: ExtensionCommandContext,
  extensionId: string,
): Promise<void> {
  const ext = SF_PI_REGISTRY.find((e) => e.id === extensionId);
  if (!ext) {
    ctx.ui.notify(`Unknown sf-pi extension: ${extensionId}.`, "warning");
    return;
  }
  if (ext.alwaysActive) {
    ctx.ui.notify(`${ext.name} is always active and cannot be toggled.`, "warning");
    return;
  }

  const scope = resolveOmpConfigScope(ctx.cwd);
  const disabledFiles = readOmpDisabledExtensionFiles(ctx.cwd, scope);
  const wasEnabled = !disabledFiles.has(ext.file);
  if (wasEnabled) disabledFiles.add(ext.file);
  else disabledFiles.delete(ext.file);
  const configPath = writeOmpDisabledExtensionFiles(ctx.cwd, scope, disabledFiles);
  ctx.ui.notify(
    `${ext.name} ${wasEnabled ? "disabled" : "enabled"} in ${configPath}. Restart OMP to apply.`,
    "info",
  );
}
