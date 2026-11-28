/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Storage for bundled-extension enable/disable state: OMP-native
 * `disabledExtensions` (`extension-module:<id>`) in OMP YAML config. OMP never
 * rebinds extension factories on `ctx.reload()`, so the requirePiVersion gate
 * applies a change on the next OMP start.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ManagerScope } from "../../../lib/common/manager-actions.ts";
import {
  ompConfigPath,
  readOmpDisabledExtensionFiles,
  writeOmpDisabledExtensionFiles,
} from "../../../lib/common/omp-extension-state.ts";

export interface EnablementTarget {
  /** OMP config.yml that stores the state. */
  location: string;
  disabledFiles: Set<string>;
  apply(disabledFiles: Set<string>): void;
}

export function resolveEnablementTarget(cwd: string, scope: ManagerScope): EnablementTarget {
  return {
    location: ompConfigPath(scope, cwd),
    disabledFiles: readOmpDisabledExtensionFiles(cwd, scope),
    apply: (disabledFiles) => {
      writeOmpDisabledExtensionFiles(cwd, scope, disabledFiles);
    },
  };
}

/** Tell the user where the change was written; OMP applies it on the next start. */
export function finishEnablementChange(
  ctx: Pick<ExtensionCommandContext, "ui">,
  target: EnablementTarget,
  message: string,
): void {
  ctx.ui.notify(`${message} in ${target.location}. Restart OMP to apply.`, "info");
}
