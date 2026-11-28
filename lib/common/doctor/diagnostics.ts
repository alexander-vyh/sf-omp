/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Read-only sf-pi doctor diagnostics.
 *
 * Keep this module side-effect free. Command handlers and startup code use it
 * to decide what to display; repair code lives in fixes.ts.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getInstalledPiVersion } from "../pi-compat.ts";
import { isNodeRuntimeSupported, NODE_RUNTIME_FLOOR } from "../runtime-floor.ts";
import { globalSettingsPath, projectSettingsPath } from "../pi-paths.ts";
import {
  logicalSkillSettingsValues,
  nativeSkillSettingsPath,
  readSkillSettingsDocument,
  resolveSkillSourcePath,
  skillSettingsValues,
  skillSourceIdentity,
} from "../skill-sources/skill-settings.ts";
import type {
  AvailableSkillRoot,
  DoctorIssue,
  DoctorReport,
  RuntimeDiagnostics,
  SkillCollision,
  SkillLocation,
  SkillRootKind,
  StaleSkillPath,
  StartupDoctorNudge,
} from "./types.ts";

interface SkillRootCandidate {
  root: string;
  label: string;
  kind: SkillRootKind;
  settingsValue?: string;
}

/**
 * Native OMP global skill settings: the agent skills root plus
 * `skills.customDirectories`, the same entries `/sf-pi doctor fix skills` edits.
 */
interface GlobalSkillSettings {
  /** `<agentDir>/skills`; absent when the agent dir is outside this checkout's `.runtime`. */
  agentSkillsRoot?: string;
  /** Entries as the SF source UI writes them; individual SKILL.md files stay files. */
  logical: string[];
  /** Directory roots OMP's loader actually scans. */
  native: string[];
}

export function runDoctorDiagnostics(options: { cwd?: string; home?: string } = {}): DoctorReport {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  const globalSettings = readJsonObject(globalSettingsPath());
  const projectSettings = readJsonObject(projectSettingsPath(cwd));
  const effectiveSettings = { ...globalSettings, ...projectSettings };
  const sfPiSettings = readObject(effectiveSettings.sfPi);
  const welcomeSettings = readObject(sfPiSettings.welcome);
  const welcomeMode = typeof welcomeSettings.mode === "string" ? welcomeSettings.mode : undefined;

  const skillSettings = readGlobalSkillSettings();
  const skillLocations = discoverSkillLocations(cwd, home, skillSettings);
  const skillCollisions = findSkillCollisions(skillLocations);
  const staleSkillPaths = findStaleSkillPaths(skillSettings.logical, cwd, home);
  const availableSkillRoots = findAvailableSkillRoots(skillSettings.logical, cwd, home);
  const runtime = collectRuntimeDiagnostics();
  const safeStartRequested = isTruthyEnv(process.env.SF_PI_SAFE_START);
  const welcomeDisabled = isWelcomeDisabled(effectiveSettings);

  const issues: DoctorIssue[] = [];
  if (!isNodeRuntimeSupported(runtime.nodeVersion)) {
    issues.push({
      id: "node-version-old",
      severity: "error",
      title: `Node.js is older than ${NODE_RUNTIME_FLOOR}`,
      detail: `Detected ${runtime.nodeVersion}. sf-pi requires Node.js ${NODE_RUNTIME_FLOOR} or newer.`,
      fix: "Install a current Node.js release, then reinstall sf-pi.",
    });
  }

  if (skillCollisions.length > 0) {
    const duplicateCount = skillCollisions.reduce((sum, c) => sum + c.duplicates.length, 0);
    issues.push({
      id: "skill-collisions",
      severity: "warn",
      title: `${skillCollisions.length} duplicate skill name(s) detected`,
      detail: `${duplicateCount} duplicate skill location(s) will be skipped by OMP at startup.`,
      fix: "Run `/sf-pi doctor fix skills` to move duplicate sf-* skills to quarantine and reload.",
    });
  }

  if (staleSkillPaths.length > 0) {
    issues.push({
      id: "stale-skill-paths",
      severity: "warn",
      title: `${staleSkillPaths.length} stale skills.customDirectories path(s)`,
      detail: "OMP config skills.customDirectories includes paths that no longer exist.",
      fix: "Run `/sf-pi doctor fix skills` to prune stale skill paths.",
    });
  }

  if (availableSkillRoots.length > 0) {
    const skillCount = availableSkillRoots.reduce((sum, root) => sum + root.skillCount, 0);
    issues.push({
      id: "external-skills-unwired",
      severity: "info",
      title: `${availableSkillRoots.length} external skill root(s) available`,
      detail: `${skillCount} skill(s) are present in Claude/Codex/Cursor folders but are not wired into OMP.`,
      fix: "Run `/sf-pi skills` or `/sf-pi doctor fix skills` to link them.",
    });
  }

  if (safeStartRequested) {
    issues.push({
      id: "safe-start-active",
      severity: "info",
      title: "Safe start is active",
      detail: "SF_PI_SAFE_START is set, so sf-pi avoids blocking startup UI.",
      fix: "Unset SF_PI_SAFE_START after `/sf-pi doctor` reports clean startup.",
    });
  }

  return {
    ompVersion: runtime.ompVersion,
    nodeVersion: runtime.nodeVersion,
    runtime,
    welcomeMode,
    safeStartRequested,
    welcomeDisabled,
    issues,
    skillCollisions,
    staleSkillPaths,
    availableSkillRoots,
  };
}

export function summarizeStartupDoctorNudge(report: DoctorReport): StartupDoctorNudge | undefined {
  const actionable = report.issues.filter(
    (issue) => issue.severity === "warn" || issue.severity === "error",
  );
  if (actionable.length === 0 && !report.safeStartRequested) return undefined;

  const collisionCount = report.skillCollisions.length;
  const staleSkillPathCount = report.staleSkillPaths.length;
  const pieces: string[] = [];
  if (collisionCount > 0)
    pieces.push(`${collisionCount} skill collision${collisionCount === 1 ? "" : "s"}`);
  if (staleSkillPathCount > 0) {
    pieces.push(`${staleSkillPathCount} stale skill path${staleSkillPathCount === 1 ? "" : "s"}`);
  }
  if (pieces.length === 0 && report.safeStartRequested) pieces.push("safe start active");

  return {
    issueCount: actionable.length,
    collisionCount,
    staleSkillPathCount,
    safeStartRequested: report.safeStartRequested,
    message: pieces.join(" · "),
    command: "/sf-pi doctor",
  };
}

export function isWelcomeDisabled(settings?: Record<string, unknown>): boolean {
  if (isTruthyEnv(process.env.SF_PI_WELCOME_OFF)) return true;
  if (String(process.env.SF_PI_WELCOME ?? "").toLowerCase() === "off") return true;
  const root = settings ?? {
    ...readJsonObject(globalSettingsPath()),
    ...readJsonObject(projectSettingsPath(process.cwd())),
  };
  const sfPi = readObject(root.sfPi);
  const welcome = readObject(sfPi.welcome);
  return welcome.mode === "off";
}

export function resolveConfiguredWelcomeMode(cwd: string): "header" | "off" {
  const merged = {
    ...readJsonObject(globalSettingsPath()),
    ...readJsonObject(projectSettingsPath(cwd)),
  };
  if (isTruthyEnv(process.env.SF_PI_SAFE_START)) return "header";
  if (String(process.env.SF_PI_WELCOME ?? "").toLowerCase() === "off") return "off";
  const sfPi = readObject(merged.sfPi);
  const welcome = readObject(sfPi.welcome);
  return welcome.mode === "off" ? "off" : "header";
}

function discoverSkillLocations(
  cwd: string,
  home: string,
  skillSettings: GlobalSkillSettings,
): SkillLocation[] {
  const roots = buildSkillRootCandidates(cwd, home, skillSettings);
  const locations: SkillLocation[] = [];
  const seenRoots = new Set<string>();
  for (const root of roots) {
    const normalizedRoot = path.resolve(root.root);
    if (seenRoots.has(normalizedRoot)) continue;
    seenRoots.add(normalizedRoot);
    if (!isDirectory(normalizedRoot)) continue;
    for (const skill of listImmediateSkills(normalizedRoot)) {
      locations.push({
        name: skill.name,
        file: skill.file,
        root: normalizedRoot,
        rootLabel: root.label,
        rootKind: root.kind,
        settingsValue: root.settingsValue,
      });
    }
  }
  return locations;
}

export function findSkillCollisions(locations: SkillLocation[]): SkillCollision[] {
  const byName = new Map<string, SkillLocation[]>();
  for (const location of locations) {
    const existing = byName.get(location.name) ?? [];
    existing.push(location);
    byName.set(location.name, existing);
  }

  const collisions: SkillCollision[] = [];
  for (const [name, matches] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Harness roots often symlink one shared install (e.g. ~/.claude/skills/x and
    // ~/.agents/skills/x -> one directory); the same file is not a competing copy.
    if (new Set(matches.map((match) => realpathOrSelf(match.file))).size <= 1) continue;
    const sorted = [...matches].sort(compareSkillLocationPriority);
    const preferred = sorted[0];
    if (!preferred) continue;
    collisions.push({ name, locations: sorted, preferred, duplicates: sorted.slice(1) });
  }
  return collisions;
}

function realpathOrSelf(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function buildSkillRootCandidates(
  cwd: string,
  home: string,
  skillSettings: GlobalSkillSettings,
): SkillRootCandidate[] {
  const roots: SkillRootCandidate[] = [
    { root: path.join(home, ".agents", "skills"), label: "Agents", kind: "agents" },
    {
      root: path.join(home, ".claude", "skills"),
      label: "Claude Code",
      kind: "claude",
      settingsValue: "~/.claude/skills",
    },
    {
      root: path.join(home, ".codex", "skills"),
      label: "OpenAI Codex",
      kind: "codex",
      settingsValue: "~/.codex/skills",
    },
    {
      root: path.join(home, ".cursor", "skills"),
      label: "Cursor",
      kind: "cursor",
      settingsValue: "~/.cursor/skills",
    },
    { root: path.join(cwd, ".omp", "skills"), label: "Project OMP", kind: "project-omp" },
    { root: path.join(cwd, ".agents", "skills"), label: "Project Agents", kind: "project-agents" },
  ];
  if (skillSettings.agentSkillsRoot) {
    roots.unshift({ root: skillSettings.agentSkillsRoot, label: "OMP", kind: "omp" });
  }

  for (const raw of skillSettings.native) {
    roots.push({
      root: resolveSkillSourcePath(raw, cwd, home),
      label: `settings:${raw}`,
      kind: "settings",
      settingsValue: raw,
    });
  }
  return roots;
}

function listImmediateSkills(root: string): Array<{ name: string; file: string }> {
  const results: Array<{ name: string; file: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const entryPath = path.join(root, entry);
    try {
      const stats = statSync(entryPath);
      if (stats.isDirectory()) {
        const skillFile = path.join(entryPath, "SKILL.md");
        if (existsSync(skillFile))
          results.push({ name: readSkillName(skillFile, entry), file: skillFile });
      } else if (
        stats.isFile() &&
        entry.endsWith(".md") &&
        root.endsWith(path.join("agent", "skills"))
      ) {
        results.push({ name: path.basename(entry, ".md"), file: entryPath });
      }
    } catch {
      // Ignore unreadable entries.
    }
  }
  return results;
}

function readSkillName(file: string, fallback: string): string {
  try {
    const raw = readFileSync(file, "utf8");
    const match = /^---\s*\n([\s\S]*?)\n---/.exec(raw);
    if (!match) return fallback;
    const nameMatch = /^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(match[1] ?? "");
    return nameMatch?.[1]?.trim() || fallback;
  } catch {
    return fallback;
  }
}

function compareSkillLocationPriority(a: SkillLocation, b: SkillLocation): number {
  return (
    skillRootPriority(a.rootKind) - skillRootPriority(b.rootKind) || a.file.localeCompare(b.file)
  );
}

function skillRootPriority(kind: SkillRootKind): number {
  switch (kind) {
    case "claude":
      return 10;
    case "omp":
      return 20;
    case "agents":
      return 30;
    case "codex":
      return 40;
    case "cursor":
      return 50;
    case "project-omp":
      return 60;
    case "project-agents":
      return 70;
    case "settings":
      return 80;
  }
}

function readGlobalSkillSettings(): GlobalSkillSettings {
  let settingsPath: string;
  try {
    settingsPath = nativeSkillSettingsPath("global");
  } catch {
    return { logical: [], native: [] };
  }
  const agentSkillsRoot = path.join(path.dirname(settingsPath), "skills");
  try {
    const document = readSkillSettingsDocument(settingsPath);
    return {
      agentSkillsRoot,
      logical: logicalSkillSettingsValues(document).customDirectories,
      native: skillSettingsValues(document).customDirectories,
    };
  } catch {
    return { agentSkillsRoot, logical: [], native: [] };
  }
}

function findStaleSkillPaths(
  customDirectories: string[],
  cwd: string,
  home: string,
): StaleSkillPath[] {
  const stale: StaleSkillPath[] = [];
  for (const raw of customDirectories) {
    const resolved = resolveSkillSourcePath(raw, cwd, home);
    const liveSkillFile = path.basename(resolved) === "SKILL.md" && existsSync(resolved);
    if (!isDirectory(resolved) && !liveSkillFile) stale.push({ raw, resolved });
  }
  return stale;
}

function findAvailableSkillRoots(
  customDirectories: string[],
  cwd: string,
  home: string,
): AvailableSkillRoot[] {
  const wired = new Set(customDirectories.map((value) => skillSourceIdentity(value, cwd, home)));
  const candidates = [
    {
      label: "Claude Code",
      settingsPath: "~/.claude/skills",
      absolutePath: path.join(home, ".claude", "skills"),
    },
    {
      label: "OpenAI Codex",
      settingsPath: "~/.codex/skills",
      absolutePath: path.join(home, ".codex", "skills"),
    },
    {
      label: "Cursor",
      settingsPath: "~/.cursor/skills",
      absolutePath: path.join(home, ".cursor", "skills"),
    },
  ];
  return candidates
    .filter(
      (candidate) =>
        isDirectory(candidate.absolutePath) &&
        !wired.has(skillSourceIdentity(candidate.absolutePath, cwd, home)),
    )
    .map((candidate) => ({
      ...candidate,
      skillCount: listImmediateSkills(candidate.absolutePath).length,
    }));
}

/** Host runtime facts, all in-process, so startup surfaces can read them cheaply. */
function collectRuntimeDiagnostics(): RuntimeDiagnostics {
  return {
    ompVersion: getInstalledPiVersion(),
    nodeVersion: process.version,
    nodePath: process.execPath,
  };
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return readObject(parsed);
  } catch {
    return {};
  }
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isDirectory(absolute: string): boolean {
  try {
    return statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}
