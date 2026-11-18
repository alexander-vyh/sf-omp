/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Skill-source discovery and native OMP configuration for SF Skills.
 *
 * OMP loads configured roots from skills.customDirectories in YAML:
 * global config lives under the repository-isolated agent directory, and
 * project config lives at <cwd>/.omp/config.yml. SF source registry metadata
 * remains separate. Reads tolerate malformed config; writes refuse to erase it.
 *
 * Relative native roots resolve against the skill loader's cwd, not $HOME or
 * the config directory. Newly added relative roots are persisted absolutely
 * so global wiring cannot drift when the next session opens another project.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  nativeSkillSettingsPath,
  readSkillSettingsDocument,
  resolveSkillSourcePath,
  logicalSkillSettingsValues,
  skillSourceIdentity,
  writeSkillSourceSettings,
} from "./skill-settings.ts";

/** Where a candidate writes when the user opts it in. */
export type SkillSourceScope = "global" | "project";

/**
 * A known skill directory on disk, including empty roots the user may populate.
 * Counts follow OMP's immediate child-directory SKILL.md convention. OMP
 * validates frontmatter at load time; discovery does not read skill contents.
 */
export interface SkillSourceCandidate {
  /** Absolute path, with the user's home dir substituted back to `~` for display. */
  displayPath: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Portable value to write to native skills.customDirectories. */
  settingsPath: string;
  /** Short human label shown in the overlay (e.g. "Claude Code"). */
  label: string;
  /** Number of immediate child directories containing SKILL.md. */
  skillCount: number;
  /** True when this path already appears (verbatim or resolved) in the
   *  candidate's target settings file. */
  wired: boolean;
  /** Which settings file this candidate writes to when wired in. */
  scope: SkillSourceScope;
}

interface KnownRoot {
  /** Absolute path (already ~-expanded) of the root to probe. */
  absolute: string;
  /** Value we write to settings when the user opts in. */
  settingsValue: string;
  /** Short label shown in the overlay. */
  label: string;
  /** Which settings file the value belongs in. */
  scope: SkillSourceScope;
}

/**
 * Native and agents roots are already discovered by OMP; external harness
 * roots are offered for explicit user opt-in.
 */
function knownGlobalRoots(home: string): KnownRoot[] {
  return [
    {
      absolute: path.join(home, ".claude", "skills"),
      settingsValue: "~/.claude/skills",
      label: "Claude Code",
      scope: "global",
    },
    {
      absolute: path.join(home, ".codex", "skills"),
      settingsValue: "~/.codex/skills",
      label: "OpenAI Codex",
      scope: "global",
    },
    {
      absolute: path.join(home, ".cursor", "skills"),
      settingsValue: "~/.cursor/skills",
      label: "Cursor",
      scope: "global",
    },
  ];
}

/**
 * Build the fixed list of external skill roots we probe for at *project*
 * scope. These mirror the global roots but live inside the current
 * working tree (e.g. a repo that ships its own `.claude/skills`). They
 * write to `<cwd>/.omp/config.yml` so wiring is per-project.
 * Native and agents roots are excluded because OMP discovers them itself.
 */
function knownProjectRoots(cwd: string): KnownRoot[] {
  return [
    {
      absolute: path.join(cwd, ".claude", "skills"),
      settingsValue: "./.claude/skills",
      label: "Claude Code (project)",
      scope: "project",
    },
    {
      absolute: path.join(cwd, ".codex", "skills"),
      settingsValue: "./.codex/skills",
      label: "OpenAI Codex (project)",
      scope: "project",
    },
    {
      absolute: path.join(cwd, ".cursor", "skills"),
      settingsValue: "./.cursor/skills",
      label: "Cursor (project)",
      scope: "project",
    },
  ];
}

export interface SkillSourcesResult {
  /** Global settings file path — always returned for backwards compatibility. */
  settingsPath: string;
  /** Project settings file path when trusted project scope was supplied, else undefined. */
  projectSettingsPath?: string;
  /** True when project-local roots/settings were included in this detection pass. */
  projectIncluded: boolean;
  /** Every candidate root we detected on disk, wired or not. */
  candidates: SkillSourceCandidate[];
  /** Native customDirectories entries that point at a non-existent directory. */
  staleWired: string[];
}

/**
 * Discover external skill roots on disk and cross-reference them with
 * the user's current native YAML skills.customDirectories arrays.
 *
 * Pass trusted `cwd` to include `<cwd>/.omp/config.yml` and project roots.
 *
 * The result is safe to render even when settings are missing or malformed.
 */
export function detectSkillSources(
  opts: { home?: string; cwd?: string; includeProject?: boolean } | string = {},
): SkillSourcesResult {
  // Backwards-compat: legacy callers passed `home` positionally.
  const args = typeof opts === "string" ? { home: opts } : opts;
  const home = args.home ?? os.homedir();
  const cwd = args.cwd;
  const includeProject = !!cwd && args.includeProject !== false;

  const globalPath = nativeSkillSettingsPath("global");
  const projectPath = includeProject ? nativeSkillSettingsPath("project", cwd) : undefined;
  const globalWired = readWiredSkillPaths(globalPath, home, cwd);
  const projectWired = projectPath ? readWiredSkillPaths(projectPath, home, cwd) : null;

  const candidates: SkillSourceCandidate[] = [];
  const roots: KnownRoot[] = [...knownGlobalRoots(home)];
  if (includeProject) roots.push(...knownProjectRoots(cwd));

  for (const root of roots) {
    if (!isDirectory(root.absolute)) continue;
    const wiredSet = root.scope === "project" ? projectWired : globalWired;
    const wired = !!(
      wiredSet &&
      (wiredSet.absolute.has(skillSourceIdentity(root.absolute, cwd, home)) ||
        wiredSet.raw.has(root.settingsValue))
    );
    candidates.push({
      displayPath: toDisplayPath(root.absolute, home),
      absolutePath: root.absolute,
      settingsPath: root.settingsValue,
      label: root.label,
      skillCount: countSkillEntries(root.absolute),
      wired,
      scope: root.scope,
    });
  }

  const staleWired: string[] = [];
  const seenStale = new Set<string>();
  for (const wired of [globalWired, projectWired]) {
    if (!wired) continue;
    for (const raw of wired.raw) {
      const resolved = resolveSkillSourcePath(raw, cwd, home);
      if (!resolved) continue;
      if (isDirectory(resolved) || (path.basename(resolved) === "SKILL.md" && existsSync(resolved)))
        continue;
      if (seenStale.has(raw)) continue;
      seenStale.add(raw);
      staleWired.push(raw);
    }
  }

  return {
    settingsPath: globalPath,
    projectSettingsPath: projectPath,
    projectIncluded: includeProject,
    candidates,
    staleWired,
  };
}

/**
 * Update native YAML skills.customDirectories without changing any other setting.
 *
 * Add/remove values match by normalized real path when available. Project scope
 * requires cwd; global scope is confined to this repository's runtime directory.
 * The return shape remains compatible with existing SF Skills callers.
 */
export function updateSkillSources(args: {
  add: string[];
  remove: string[];
  scope?: SkillSourceScope;
  cwd?: string;
  home?: string;
  settingsFile?: string;
}): { settingsPath: string; skills: string[] } {
  const home = args.home ?? os.homedir();
  const scope: SkillSourceScope = args.scope ?? "global";
  const canonical = nativeSkillSettingsPath(scope, args.cwd);
  const settingsPath = args.settingsFile ?? canonical;
  if (path.resolve(settingsPath) !== path.resolve(canonical)) {
    throw new Error(`Skill-source mutations must target native OMP config ${canonical}.`);
  }
  const root = readSkillSettingsDocument(settingsPath);
  const { customDirectories: existing } = logicalSkillSettingsValues(root);
  const identity = (value: string) => skillSourceIdentity(value, args.cwd, home);
  const removeAbsolute = new Set(args.remove.map(identity));
  const retained: string[] = [];
  const seen = new Set<string>();
  for (const value of existing) {
    const absolute = identity(value);
    if (removeAbsolute.has(absolute) || seen.has(absolute)) continue;
    retained.push(value);
    seen.add(absolute);
  }
  for (const value of args.add) {
    if (!value.trim()) continue;
    const absolute = identity(value);
    if (seen.has(absolute)) continue;
    // Persist relative additions against the actual loader cwd, never the YAML directory.
    retained.push(
      value.startsWith("~/") || value === "~" || path.isAbsolute(value)
        ? value
        : resolveSkillSourcePath(value, args.cwd, home),
    );
    seen.add(absolute);
  }
  const unchanged =
    retained.length === existing.length &&
    retained.every((value, index) => value === existing[index]);
  if (!unchanged) {
    writeSkillSourceSettings(settingsPath, root, retained, scope, args.cwd, home);
  }
  return { settingsPath, skills: retained };
}

// -------------------------------------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------------------------------------

interface WiredPaths {
  /** Raw strings as they appear in settings (e.g. "~/.claude/skills"). */
  raw: Set<string>;
  /** Fully-resolved absolute paths, used for cross-form comparison. */
  absolute: Set<string>;
}

function readWiredSkillPaths(settingsPath: string, home: string, cwd?: string): WiredPaths {
  const result: WiredPaths = { raw: new Set(), absolute: new Set() };
  let skills: string[];
  try {
    skills = logicalSkillSettingsValues(readSkillSettingsDocument(settingsPath)).customDirectories;
  } catch {
    return result;
  }
  for (const value of skills) {
    result.raw.add(value);
    result.absolute.add(skillSourceIdentity(value, cwd, home));
  }
  return result;
}

function toDisplayPath(absolute: string, home: string): string {
  return absolute.startsWith(`${home}${path.sep}`)
    ? `~/${path.relative(home, absolute)}`
    : absolute;
}

function isDirectory(absolute: string): boolean {
  try {
    return statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Count the discoverable skill entries under a root.
 *
 * Mirror OMP's custom directory scanner: visible child directories containing
 * SKILL.md count; loose Markdown files and hidden directories do not.
 *
 * This is a cheap heuristic for the overlay label — it never throws.
 */
function countSkillEntries(root: string): number {
  let count = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const full = path.join(root, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        if (existsSync(path.join(full, "SKILL.md"))) count += 1;
      }
    } catch {
      // Skip unreadable entries.
    }
  }
  return count;
}

/**
 * Summary string used by the splash nudge and `/sf-pi skills status`.
 *
 * Returns `null` when nothing needs attention (zero detected roots, or
 * every detected root already wired) so callers can hide the nudge.
 */
export function summarizeAvailableSkillSources(home: string = os.homedir()): {
  availableCount: number;
  totalSkillCount: number;
} | null {
  const result = detectSkillSources(home);
  const available = result.candidates.filter((c) => !c.wired);
  if (available.length === 0) return null;
  const totalSkillCount = available.reduce((sum, c) => sum + c.skillCount, 0);
  return { availableCount: available.length, totalSkillCount };
}
