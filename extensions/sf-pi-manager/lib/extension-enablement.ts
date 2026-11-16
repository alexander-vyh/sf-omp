/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Host-specific storage for bundled-extension enable/disable state.
 *
 * Pi: package filters in Pi `settings.json`; `ctx.reload()` re-reads them.
 * OMP: native `disabledExtensions` (`extension-module:<id>`) in OMP YAML config.
 *      OMP ignores Pi settings and never rebinds extension factories on
 *      `ctx.reload()`, so the requirePiVersion gate applies it on next start.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ManagerScope } from "../../../lib/common/manager-actions.ts";
import {
  ompConfigPath,
  readOmpDisabledExtensionFiles,
  resolveOmpConfigScope,
  writeOmpDisabledExtensionFiles,
} from "../../../lib/common/omp-extension-state.ts";
import {
  applyExtensionState,
  findPackageInSettings,
  getDisabledExtensions,
  resolveEffectiveScope,
} from "../../../lib/common/sf-pi-package-state.ts";

export interface EnablementTarget {
  host: "pi" | "omp";
  scope: ManagerScope;
  /** File that stores the state: Pi settings.json or OMP config.yml. */
  location: string;
  /** Pi package source string; absent under OMP (loaded via the launcher). */
  source?: string;
  disabledFiles: Set<string>;
  apply(disabledFiles: Set<string>): void;
}

/** Default scope: where the state already lives (project over global). */
export function resolveManagerScope(omp: boolean, cwd: string): ManagerScope {
  return omp ? resolveOmpConfigScope(cwd) : resolveEffectiveScope(cwd);
}

/** Null only on Pi when the sf-pi package is absent from that settings scope. */
export function resolveEnablementTarget(
  omp: boolean,
  cwd: string,
  scope: ManagerScope,
): EnablementTarget | null {
  if (omp) {
    return {
      host: "omp",
      scope,
      location: ompConfigPath(scope, cwd),
      disabledFiles: readOmpDisabledExtensionFiles(cwd, scope),
      apply: (disabledFiles) => {
        writeOmpDisabledExtensionFiles(cwd, scope, disabledFiles);
      },
    };
  }
  const match = findPackageInSettings(cwd, scope);
  if (!match) return null;
  return {
    host: "pi",
    scope,
    location: match.settingsPath,
    source: match.source,
    disabledFiles: getDisabledExtensions(match.settingsPath),
    apply: (disabledFiles) => applyExtensionState(match, disabledFiles),
  };
}

/** Tell the user how the change takes effect; reload only where it re-reads the state. */
export async function finishEnablementChange(
  ctx: ExtensionCommandContext,
  target: EnablementTarget,
  message: string,
): Promise<void> {
  if (target.host === "omp") {
    ctx.ui.notify(`${message} in ${target.location}. Restart OMP to apply.`, "info");
    return;
  }
  ctx.ui.notify(`${message}. Reloading…`, "info");
  await ctx.reload();
}
