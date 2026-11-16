/* SPDX-License-Identifier: Apache-2.0 */
/** Bundled extensions the user disabled for this cwd, read from the running host's own config. */
import { SF_PI_REGISTRY } from "../../../catalog/registry.ts";
import { isOmpHost } from "../../../lib/common/pi-compat.ts";
import {
  isExtensionDisabledInOmpConfig,
  isSfPiExtensionEnabled,
} from "../../../lib/common/sf-pi-extension-state.ts";

export const BUNDLED_EXTENSION_IDS: ReadonlySet<string> = new Set(
  SF_PI_REGISTRY.map((extension) => extension.id),
);

/**
 * OMP ignores Pi settings.json package filters and records disables as
 * `extension-module:<id>` in its YAML config; Pi uses the package filters.
 */
export function disabledExtensionIds(pi: unknown, cwd: string): ReadonlySet<string> {
  const omp = isOmpHost(pi);
  return new Set(
    SF_PI_REGISTRY.filter((extension) =>
      omp
        ? isExtensionDisabledInOmpConfig(extension.id, cwd)
        : !isSfPiExtensionEnabled(cwd, extension.id),
    ).map((extension) => extension.id),
  );
}
