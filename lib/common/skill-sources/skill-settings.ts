/* SPDX-License-Identifier: Apache-2.0 */
/** Native OMP 18.17 skill settings. SF-only metadata deliberately stays separate. */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";

export type SkillSettingsScope = "global" | "project";

const runtimeRoot = fileURLToPath(new URL("../../../.runtime/", import.meta.url));

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** Never use OMP's home-directory fallback, including when imported outside the launcher. */
export function skillAgentDir(): string {
  const agentDir = path.resolve(
    process.env.PI_CODING_AGENT_DIR ?? path.join(runtimeRoot, "omp", "agent"),
  );
  if (!isWithin(runtimeRoot, agentDir)) {
    throw new Error(
      "Skill settings require PI_CODING_AGENT_DIR inside this repository's .runtime directory.",
    );
  }
  assertSkillSettingsBoundary(agentDir, "global");
  return agentDir;
}

/** OMP reads config.yml first, then config.yaml globally; project config is .omp/config.yml only. */
export function nativeSkillSettingsPath(scope: SkillSettingsScope, cwd?: string): string {
  if (scope === "project") {
    if (!cwd) throw new Error("Project skill settings require cwd.");
    return path.resolve(cwd, ".omp", "config.yml");
  }
  const directory = skillAgentDir();
  const canonical = path.join(directory, "config.yml");
  const fallback = path.join(directory, "config.yaml");
  return existsSync(canonical) || !existsSync(fallback) ? canonical : fallback;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Missing files are empty; malformed files must not be silently overwritten by a mutation. */
export function readSkillSettingsDocument(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  const parsed: unknown = YAML.parse(readFileSync(settingsPath, "utf8"));
  if (parsed === null || parsed === undefined) return {};
  if (!record(parsed)) throw new Error(`Expected a YAML settings mapping in ${settingsPath}.`);
  return parsed;
}

export function skillSettingsValues(document: Record<string, unknown>): {
  customDirectories: string[];
  ignoredSkills: string[];
} {
  const skills = document.skills;
  if (skills !== undefined && !record(skills))
    throw new Error("Native OMP settings.skills must be a mapping.");
  const values = record(skills) ? skills : {};
  const strings = (value: unknown, key: string): string[] => {
    if (value === undefined || value === null) return [];
    if (
      !Array.isArray(value) ||
      !value.every((entry): entry is string => typeof entry === "string")
    ) {
      throw new Error(`Native OMP skills.${key} must be a string array.`);
    }
    return value;
  };
  return {
    customDirectories: strings(values.customDirectories, "customDirectories"),
    ignoredSkills: strings(values.ignoredSkills, "ignoredSkills"),
  };
}

/** Both global and project customDirectories resolve against the skill loader's cwd, NOT the config directory. */
export function resolveSkillSourcePath(
  value: string,
  cwd: string = process.cwd(),
  home: string = os.homedir(),
): string {
  if (value === "~") return path.resolve(home);
  if (value.startsWith("~/")) return path.resolve(home, value.slice(2));
  return path.resolve(cwd, value);
}

/** Match aliases the way native skill loading deduplicates files, with lexical fallback for stale roots. */
export function skillSourceIdentity(value: string, cwd?: string, home?: string): string {
  const absolute = resolveSkillSourcePath(value, cwd, home);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export interface NativeSkillSourceSettings {
  settingsPath: string;
  /** Logical roots or individual SKILL.md files used by the SF source/gate UI. */
  customDirectories: string[];
  /** Actual directory roots passed to the native OMP loader. */
  nativeDirectories: string[];
  ignoredSkills: string[];
}

/** Reverse only our own isolated projections, keeping existing native roots untouched. */
export function logicalSkillSettingsValues(document: Record<string, unknown>): {
  customDirectories: string[];
  ignoredSkills: string[];
} {
  const values = skillSettingsValues(document);
  const files = document.sfOmpSkillSourceFiles;
  return {
    ...values,
    customDirectories: values.customDirectories.map((directory) =>
      record(files) && typeof files[directory] === "string"
        ? (files[directory] as string)
        : directory,
    ),
  };
}

/** Read one native config path without reading any other scope. Discovery is tolerant. */
export function readSkillSourceSettings(
  settingsPath: string,
  cwd?: string,
  home?: string,
): NativeSkillSourceSettings {
  try {
    const document = readSkillSettingsDocument(settingsPath);
    const native = skillSettingsValues(document);
    const logical = logicalSkillSettingsValues(document);
    return {
      settingsPath,
      customDirectories: logical.customDirectories.map((value) =>
        resolveSkillSourcePath(value, cwd, home),
      ),
      nativeDirectories: native.customDirectories.map((value) =>
        resolveSkillSourcePath(value, cwd, home),
      ),
      ignoredSkills: native.ignoredSkills,
    };
  } catch {
    return { settingsPath, customDirectories: [], nativeDirectories: [], ignoredSkills: [] };
  }
}

/** Native project scope is read only when the trusted caller explicitly requests it. */
export function readSkillSettings(
  scope: SkillSettingsScope,
  cwd?: string,
): NativeSkillSourceSettings {
  return readSkillSourceSettings(nativeSkillSettingsPath(scope, cwd), cwd);
}

/**
 * OMP customDirectories scans child directories, not individual files or its own
 * SKILL.md. A per-file SF gate therefore needs a root with exactly one child
 * directory symlink. Linking the entire skill directory preserves relative assets.
 */
export function writeSkillSourceSettings(
  settingsPath: string,
  document: Record<string, unknown>,
  directories: string[],
  scope: SkillSettingsScope,
  cwd?: string,
  home?: string,
): void {
  assertSkillSettingsBoundary(settingsPath, scope, cwd);
  if (document.sfOmpSkillSourceFiles !== undefined && !record(document.sfOmpSkillSourceFiles)) {
    throw new Error("SF skill source projection metadata must be a mapping.");
  }
  const projectionBase = path.join(
    path.dirname(path.resolve(settingsPath)),
    "sf-skills",
    "source-projections",
  );
  const files: Record<string, string> = {};
  const nativeDirectories: string[] = [];
  for (const value of directories) {
    const absolute = resolveSkillSourcePath(value, cwd, home);
    if (!absolute.endsWith(`${path.sep}SKILL.md`)) {
      if (existsSync(absolute) && statSync(absolute).isFile()) {
        throw new Error(
          `OMP skill sources require directories or SKILL.md files, not ${absolute}.`,
        );
      }
      nativeDirectories.push(value);
      continue;
    }
    const sourceDirectory = path.dirname(absolute);
    const projection = path.join(
      projectionBase,
      createHash("sha256").update(absolute).digest("hex"),
    );
    const child = path.join(projection, path.basename(sourceDirectory));
    assertSkillSettingsBoundary(projection, scope, cwd);
    mkdirSync(projection, { recursive: true });
    try {
      const entry = lstatSync(child);
      if (
        !entry.isSymbolicLink() ||
        path.resolve(path.dirname(child), readlinkSync(child)) !== sourceDirectory
      ) {
        throw new Error(`Refusing to replace unexpected skill projection entry ${child}.`);
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      symlinkSync(sourceDirectory, child, "dir");
    }
    files[projection] = value;
    nativeDirectories.push(projection);
  }
  const next = { ...document };
  const skills = record(document.skills) ? document.skills : {};
  next.skills = { ...skills, customDirectories: nativeDirectories };
  if (Object.keys(files).length > 0) next.sfOmpSkillSourceFiles = files;
  else delete next.sfOmpSkillSourceFiles;
  writeSkillSettingsDocument(settingsPath, next, scope, cwd);
  // Projections are generated state; remove only roots described by our previous mapping.
  if (record(document.sfOmpSkillSourceFiles)) {
    for (const previous of Object.keys(document.sfOmpSkillSourceFiles)) {
      if (
        files[previous] ||
        path.dirname(previous) !== projectionBase ||
        !/^[a-f0-9]{64}$/.test(path.basename(previous))
      )
        continue;
      assertSkillSettingsBoundary(previous, scope, cwd);
      rmSync(previous, { recursive: true, force: true });
    }
  }
}

/** Refuse symlink escapes before creating settings or managed projection directories. */
function assertSkillSettingsBoundary(
  settingsPath: string,
  scope: SkillSettingsScope,
  cwd?: string,
): void {
  if (scope === "project" && !cwd) throw new Error("Project skill settings require cwd.");
  const boundary = scope === "global" ? runtimeRoot : path.resolve(cwd ?? process.cwd());
  const absolute = path.resolve(settingsPath);
  if (!isWithin(boundary, absolute))
    throw new Error(`Skill settings path escapes ${scope} scope: ${absolute}`);
  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  // Compare real paths of existing ancestors, including a config file symlink.
  let boundaryAncestor = scope === "global" ? path.dirname(runtimeRoot) : boundary;
  while (!existsSync(boundaryAncestor)) boundaryAncestor = path.dirname(boundaryAncestor);
  const realBoundary = path.resolve(
    realpathSync(boundaryAncestor),
    path.relative(boundaryAncestor, boundary),
  );
  const physicalTarget = path.resolve(realpathSync(ancestor), path.relative(ancestor, absolute));
  if (!isWithin(realBoundary, physicalTarget))
    throw new Error(`Skill settings symlink escapes ${scope} scope: ${absolute}`);
}

/** Atomic YAML replacement, preserving every unrelated native setting. */
export function writeSkillSettingsDocument(
  settingsPath: string,
  document: Record<string, unknown>,
  scope: SkillSettingsScope,
  cwd?: string,
): void {
  assertSkillSettingsBoundary(settingsPath, scope, cwd);
  const absolute = path.resolve(settingsPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${YAML.stringify(document).trimEnd()}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, absolute);
  } finally {
    rmSync(temporary, { force: true });
  }
}
