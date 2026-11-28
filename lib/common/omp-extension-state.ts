/* SPDX-License-Identifier: Apache-2.0 */
/**
 * OMP-native enablement state for bundled SF Pi extensions.
 *
 * OMP's switch is `disabledExtensions` in its YAML config, where an entry
 * `extension-module:<id>` disables the extension module whose directory is
 * `extensions/<id>/` (global `<agentDir>/config.yml`, project
 * `<cwd>/.omp/config.yml`; OMP replaces arrays across layers, so a project list
 * wins over the global one).
 *
 * The sf-omp launcher loads extensions explicit-only (`--no-extensions -e
 * <root>`), a mode in which OMP skips that setting, and OMP's `ctx.reload()`
 * never rebinds extension factories. `requirePiVersion()` therefore consults
 * this state at factory time, so a change applies on the next OMP start.
 */
import { SF_PI_REGISTRY } from "../../catalog/registry.ts";
import {
  nativeSkillSettingsPath,
  readSkillSettingsDocument,
  writeSkillSettingsDocument,
} from "./skill-sources/skill-settings.ts";

export type OmpConfigScope = "global" | "project";

const MODULE_PREFIX = "extension-module:";

/** Native OMP YAML config file for a scope (the same file native skill settings use). */
export function ompConfigPath(scope: OmpConfigScope, cwd: string): string {
  return nativeSkillSettingsPath(scope, cwd);
}

function disabledEntries(document: Record<string, unknown>): string[] | undefined {
  const value = document.disabledExtensions;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("Native OMP disabledExtensions must be a string array.");
  }
  return value as string[];
}

/** Project config wins when it defines `disabledExtensions`; otherwise global applies. */
export function resolveOmpConfigScope(cwd: string): OmpConfigScope {
  try {
    return disabledEntries(readSkillSettingsDocument(ompConfigPath("project", cwd)))
      ? "project"
      : "global";
  } catch {
    return "global";
  }
}

/** Registry `file` values of bundled extensions disabled in one OMP config scope. Throws on malformed config. */
export function readOmpDisabledExtensionFiles(
  cwd: string,
  scope: OmpConfigScope = resolveOmpConfigScope(cwd),
): Set<string> {
  const ids = new Set(
    (disabledEntries(readSkillSettingsDocument(ompConfigPath(scope, cwd))) ?? [])
      .filter((entry) => entry.startsWith(MODULE_PREFIX))
      .map((entry) => entry.slice(MODULE_PREFIX.length)),
  );
  return new Set(
    SF_PI_REGISTRY.filter((ext) => !ext.alwaysActive && ids.has(ext.id)).map((ext) => ext.file),
  );
}

/**
 * Replace only bundled `extension-module:<id>` entries in one scope, keeping
 * every other native entry (third-party modules, `skill:<name>`, …). A project
 * write always keeps the key so the project list keeps overriding global.
 * Returns the written config path.
 */
export function writeOmpDisabledExtensionFiles(
  cwd: string,
  scope: OmpConfigScope,
  disabledFiles: ReadonlySet<string>,
): string {
  const settingsPath = ompConfigPath(scope, cwd);
  const document = readSkillSettingsDocument(settingsPath);
  const bundled = new Set(SF_PI_REGISTRY.map((ext) => `${MODULE_PREFIX}${ext.id}`));
  const next = [
    ...(disabledEntries(document) ?? []).filter((entry) => !bundled.has(entry)),
    ...SF_PI_REGISTRY.filter((ext) => !ext.alwaysActive && disabledFiles.has(ext.file))
      .map((ext) => `${MODULE_PREFIX}${ext.id}`)
      .sort(),
  ];
  const updated = { ...document };
  if (next.length > 0 || scope === "project") updated.disabledExtensions = next;
  else delete updated.disabledExtensions;
  writeSkillSettingsDocument(settingsPath, updated, scope, cwd);
  return settingsPath;
}
