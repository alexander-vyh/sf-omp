/* SPDX-License-Identifier: Apache-2.0 */
/** Bundled extensions the user disabled for this cwd, read from the running host's own config. */
import { SF_PI_REGISTRY } from "../../../catalog/registry.ts";
import { isExtensionDisabledInOmpConfig } from "../../../lib/common/sf-pi-extension-state.ts";

export const BUNDLED_EXTENSION_IDS: ReadonlySet<string> = new Set(
  SF_PI_REGISTRY.map((extension) => extension.id),
);

/** OMP records disables as `extension-module:<id>` in its YAML config. */
export function disabledExtensionIds(cwd: string): ReadonlySet<string> {
  return new Set(
    SF_PI_REGISTRY.filter((extension) => isExtensionDisabledInOmpConfig(extension.id, cwd)).map(
      (extension) => extension.id,
    ),
  );
}
