/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Shared sf-pi extension enablement state.
 *
 * Bundled-extension disables live in OMP's native `disabledExtensions` config
 * (`extension-module:<id>`; see `./omp-extension-state.ts`). Multiple
 * extensions need to answer the same question ("is optional extension X
 * enabled?") before surfacing status UI, so this module centralizes it.
 */
import { SF_PI_REGISTRY } from "../../catalog/registry.ts";
import { readOmpDisabledExtensionFiles } from "./omp-extension-state.ts";

export type SfPiExtensionId = (typeof SF_PI_REGISTRY)[number]["id"];

const STATUS_KEY_EXTENSION_ID: Record<string, SfPiExtensionId | "always"> = {
  "sf-slack-status": "sf-slack",
  "sf-llm-gateway": "sf-llm-gateway",
  "sf-pi": "always",
};

/** Registry `file` values disabled in the OMP config for `cwd`; unreadable config disables nothing. */
export function getDisabledExtensionFilesForCwd(cwd: string): Set<string> {
  try {
    return readOmpDisabledExtensionFiles(cwd);
  } catch {
    return new Set();
  }
}

export function isSfPiExtensionEnabled(cwd: string, extensionId: SfPiExtensionId): boolean {
  if (!SF_PI_REGISTRY.some((entry) => entry.id === extensionId)) return false;
  return !isExtensionDisabledInOmpConfig(extensionId, cwd);
}

/**
 * True when the OMP-native `disabledExtensions` config for `cwd` disables this
 * bundled extension (`extension-module:<id>`). alwaysActive extensions and
 * unreadable config never count as disabled, so a bad file cannot hide tools.
 */
export function isExtensionDisabledInOmpConfig(
  extensionId: string,
  cwd: string = process.cwd(),
): boolean {
  const extension = SF_PI_REGISTRY.find((entry) => entry.id === extensionId);
  if (!extension || extension.alwaysActive) return false;
  try {
    return readOmpDisabledExtensionFiles(cwd).has(extension.file);
  } catch {
    return false;
  }
}

export function filterEnabledExtensionStatuses(
  cwd: string,
  statuses: ReadonlyMap<string, string>,
): Map<string, string> {
  const filtered = new Map<string, string>();
  for (const [key, value] of statuses) {
    const owner = STATUS_KEY_EXTENSION_ID[key];
    if (!owner) continue;
    if (owner === "always" || isSfPiExtensionEnabled(cwd, owner)) {
      filtered.set(key, value);
    }
  }
  return filtered;
}
