/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Global effective tree for managed Salesforce skills.
 *
 * The git clone stays pristine. Pi loads a sibling `effective/skills`
 * copy whose SKILL.md files may carry disable-model-invocation stamps.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  opendirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { globalAgentPath } from "../../../../lib/common/pi-paths.ts";
import {
  applyInvocationMode,
  classifyInvocationMode,
  parseFrontmatter,
  hasDisableModelInvocation,
} from "./frontmatter.ts";
import { readGlobalInvocationPolicy, resolveInvocationMode } from "./policy.ts";
import type { SkillInvocationMode, SkillInvocationPolicy } from "./types.ts";

const SKILLS_SUBDIR = "skills";
const SYNC_STATE_FILE = "sync-state.json";

/** Clone and effective content always share the runtime's agent root. */
export function managedCloneRoot(): string {
  return globalAgentPath("sf-skills", "forcedotcom");
}

export function managedEffectiveRoot(): string {
  return path.join(path.dirname(managedCloneRoot()), "effective");
}

export function managedEffectiveSkillsPath(): string {
  return path.join(managedEffectiveRoot(), SKILLS_SUBDIR);
}

export function managedEffectiveSettingsValue(): string {
  return managedEffectiveSkillsPath();
}

export interface EffectiveSkillRecord {
  name: string;
  relativeDir: string;
  cloneFile: string;
  effectiveFile: string;
  description: string;
  authorDisabled: boolean;
  currentMode: SkillInvocationMode;
  desiredMode: SkillInvocationMode;
}

export interface SyncEffectiveResult {
  copied: number;
  stamped: number;
  skills: EffectiveSkillRecord[];
}

export type EffectiveTreeState = "ready" | "missing-clone" | "missing" | "empty" | "stale";

/**
 * Constant-size local probe: one directory entry and a small revision receipt.
 * No catalog scan, subprocess, network request, or copying on the boot path.
 */
export function inspectEffectiveSkills(
  cloneSkillsPath = path.join(managedCloneRoot(), SKILLS_SUBDIR),
): EffectiveTreeState {
  const effectiveSkillsPath = managedEffectiveSkillsPath();
  if (!existsSync(cloneSkillsPath)) return "missing-clone";
  if (!existsSync(effectiveSkillsPath)) return "missing";
  try {
    const dir = opendirSync(effectiveSkillsPath);
    try {
      if (!dir.readSync()) return "empty";
    } finally {
      dir.closeSync();
    }
    const receipt = JSON.parse(
      readFileSync(path.join(managedEffectiveRoot(), SYNC_STATE_FILE), "utf8"),
    );
    return receipt.cloneSkillsPath === cloneSkillsPath &&
      receipt.cloneHead === readLocalGitHead(path.dirname(cloneSkillsPath)) &&
      receipt.cloneMtimeMs === statSync(cloneSkillsPath).mtimeMs &&
      receipt.effectiveMtimeMs === statSync(effectiveSkillsPath).mtimeMs
      ? "ready"
      : "stale";
  } catch {
    return "stale";
  }
}

/** Repair only on an explicit action or first turn, never session_start. */
export function ensureEffectiveSkills(): SyncEffectiveResult | undefined {
  const state = inspectEffectiveSkills();
  if (state === "ready" || state === "missing-clone") return undefined;
  return syncEffectiveSkills(path.join(managedCloneRoot(), SKILLS_SUBDIR));
}

export function listManagedSkillFiles(
  skillsRoot: string,
): Array<{ name: string; relativeDir: string; filePath: string }> {
  if (!existsSync(skillsRoot)) return [];
  const out: Array<{ name: string; relativeDir: string; filePath: string }> = [];
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const filePath = path.join(skillsRoot, entry.name, "SKILL.md");
    if (!existsSync(filePath) || !statSync(filePath).isFile()) continue;
    out.push({ name: skillNameFromFile(filePath, entry.name), relativeDir: entry.name, filePath });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function syncEffectiveSkills(
  cloneSkillsPath: string,
  policy = readGlobalInvocationPolicy(),
): SyncEffectiveResult {
  if (!existsSync(cloneSkillsPath) || !statSync(cloneSkillsPath).isDirectory()) {
    console.warn(
      `[sf-skills] Missing clone skills directory: ${cloneSkillsPath}; keeping effective tree at ${managedEffectiveSkillsPath()}.`,
    );
    return { copied: 0, stamped: 0, skills: [] };
  }
  const effectiveSkillsPath = managedEffectiveSkillsPath();
  mkdirSync(path.dirname(effectiveSkillsPath), { recursive: true });
  if (existsSync(effectiveSkillsPath))
    rmSync(effectiveSkillsPath, { recursive: true, force: true });
  cpSync(cloneSkillsPath, effectiveSkillsPath, { recursive: true });
  const cloneFiles = listManagedSkillFiles(cloneSkillsPath);
  let stamped = 0;
  const skills: EffectiveSkillRecord[] = [];
  for (const clone of cloneFiles) {
    const effectiveFile = path.join(effectiveSkillsPath, clone.relativeDir, "SKILL.md");
    const cloneRaw = readFileSync(clone.filePath, "utf8");
    const authorDisabled = hasDisableModelInvocation(parseFrontmatter(cloneRaw));
    const desiredMode = resolveInvocationMode({
      name: clone.name,
      authorDisabled,
      policy,
    });
    let currentRaw: string | undefined;
    try {
      currentRaw = readFileSync(effectiveFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const baseRaw = currentRaw ?? cloneRaw;
    const next = applyInvocationMode(baseRaw, desiredMode);
    if (currentRaw === undefined || next !== currentRaw) {
      mkdirSync(path.dirname(effectiveFile), { recursive: true });
      writeFileSync(effectiveFile, next, "utf8");
      stamped += 1;
    }
    skills.push({
      name: clone.name,
      relativeDir: clone.relativeDir,
      cloneFile: clone.filePath,
      effectiveFile,
      description: readDescription(cloneRaw),
      authorDisabled,
      currentMode: classifyInvocationMode(next),
      desiredMode,
    });
  }
  writeFileSync(
    path.join(managedEffectiveRoot(), SYNC_STATE_FILE),
    JSON.stringify({
      cloneSkillsPath,
      cloneHead: readLocalGitHead(path.dirname(cloneSkillsPath)),
      cloneMtimeMs: statSync(cloneSkillsPath).mtimeMs,
      effectiveMtimeMs: statSync(effectiveSkillsPath).mtimeMs,
      skillCount: cloneFiles.length,
    }),
    "utf8",
  );
  return { copied: cloneFiles.length, stamped, skills };
}

export function restampEffectiveSkills(
  cloneSkillsPath: string,
  policy: SkillInvocationPolicy = readGlobalInvocationPolicy(),
): SyncEffectiveResult {
  return syncEffectiveSkills(cloneSkillsPath, policy);
}

/**
 * Read the commit SHA pointed to by HEAD without spawning git.
 *
 * Depth-1 clones produced by `/sf-skills defaults install` always have the
 * branch tip in a loose ref under .git/refs/heads/<branch>, so this returns
 * a SHA in the common case. Falls back to packed-refs and finally to
 * `undefined` so the caller can degrade to freshness:"unknown".
 */
export function readLocalGitHead(rootPath: string): string | undefined {
  try {
    const headPath = path.join(rootPath, ".git", "HEAD");
    if (!existsSync(headPath)) return undefined;
    const head = readFileSync(headPath, "utf8").trim();
    // Detached HEAD or already-resolved SHA.
    if (/^[0-9a-f]{7,64}$/.test(head)) return head;
    // Symbolic ref: "ref: refs/heads/main"
    const match = head.match(/^ref:\s*(.+)$/);
    if (!match) return undefined;
    const refPath = match[1].trim();
    const loose = path.join(rootPath, ".git", refPath);
    if (existsSync(loose)) {
      const sha = readFileSync(loose, "utf8").trim();
      if (/^[0-9a-f]{7,64}$/.test(sha)) return sha;
    }
    // Fall back to packed-refs lookup.
    const packed = path.join(rootPath, ".git", "packed-refs");
    if (existsSync(packed)) {
      const lines = readFileSync(packed, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const [sha, ref] = trimmed.split(/\s+/);
        if (ref === refPath && /^[0-9a-f]{7,64}$/.test(sha)) return sha;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function skillNameFromFile(filePath: string, fallback: string): string {
  try {
    const raw = readFileSync(filePath, "utf8");
    const match = raw.match(/^name:\s*(.+)$/m);
    return match?.[1]?.trim().replace(/^["']|["']$/g, "") || fallback;
  } catch {
    return fallback;
  }
}

function readDescription(raw: string): string {
  const block = raw.match(/^description:\s*[>|][-+]?\n((?:[ \t].*\n)+)/m);
  if (block?.[1]) {
    return block[1]
      .split("\n")
      .map((line) => line.replace(/^[ \t]{2}/, ""))
      .join("\n")
      .trim();
  }
  const line = raw.match(/^description:\s*(.+)$/m);
  return line?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
}
