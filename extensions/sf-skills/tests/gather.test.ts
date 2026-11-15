/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Gatherer assembly tests. The gatherer is the impure bridge; here we inject
 * fake loadSkills / loadSkillsFromDir / getCommands and use temp dirs so we
 * can assert it assembles a correct SkillCatalogInput (sources, gates,
 * loadedPaths, collisions) without a live OMP runtime.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gatherCatalogInput, type GatherDeps } from "../lib/gather.ts";
import { nativeSkillSettingsPath } from "../../../lib/common/skill-sources/skill-settings.ts";
import { upsertSource } from "../../../lib/common/skill-sources/source-registry.ts";
import { updateSkillSources } from "../../../lib/common/skill-sources/skill-sources.ts";
import * as YAML from "yaml";
import { nativeTestDir } from "./native-fixture.ts";
import { buildSkillCatalog } from "../lib/catalog.ts";

const tempDirs: string[] = [];
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const originalAgentDir = process.env[AGENT_DIR_ENV];
const originalHome = process.env.HOME;

function tmp(prefix: string): string {
  const dir = nativeTestDir(prefix);
  tempDirs.push(dir);
  if (prefix === "sf-gather-home-") process.env.HOME = dir;
  return dir;
}

function writeSkill(root: string, name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n`);
  return file;
}

/** Minimal fake loadSkillsFromDir that scans <dir>/<name>/SKILL.md fixtures. */
function fakeDeps(over: Partial<GatherDeps> = {}): GatherDeps {
  return {
    home: path.resolve(process.env[AGENT_DIR_ENV]!, "../.."),
    agentDir: process.env[AGENT_DIR_ENV]!,
    loadSkills: vi.fn(async () => ({
      skills: [],
      warnings: [],
    })),
    loadSkillsFromDir: async ({ dir }) => {
      const skills: Array<{ name: string; filePath: string; description?: string }> = [];
      try {
        for (const name of readdirSync(dir)) {
          const file = path.join(dir, name, "SKILL.md");
          if (existsSync(file)) {
            skills.push({ name, filePath: file, description: `${name} skill` });
          }
        }
      } catch {
        /* missing dir */
      }
      return { skills, warnings: [] };
    },
    getCommands: () => [],
    loadUsage: () => new Map(),
    ...over,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
  else process.env[AGENT_DIR_ENV] = originalAgentDir;
});

describe("gatherCatalogInput", () => {
  it("scans a wired custom dir and marks it seen + carries settings coverage", async () => {
    const home = tmp("sf-gather-home-");
    const cwd = tmp("sf-gather-cwd-");
    const agentDir = path.join(home, ".pi", "agent");
    process.env[AGENT_DIR_ENV] = agentDir;

    // A custom skills root wired into global settings as a directory.
    const customRoot = path.join(home, "my-skills");
    writeSkill(customRoot, "alpha");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      nativeSkillSettingsPath("global", cwd),
      YAML.stringify({ skills: { customDirectories: [customRoot] } }),
    );

    const alphaFile = path.join(customRoot, "alpha", "SKILL.md");
    const input = await gatherCatalogInput({
      cwd,
      deps: fakeDeps({
        loadSkills: async () => ({
          skills: [{ name: "alpha", filePath: alphaFile }],
          warnings: [],
        }),
        getCommands: () => [
          {
            name: "skill:alpha",
            description: "",
            source: "skill",
            path: alphaFile,
          },
        ],
      }),
    });

    const customSource = input.sources.find((s) => s.rootPath === path.normalize(customRoot));
    expect(customSource).toBeDefined();
    expect(customSource!.gate).toBe("seen");
    expect(customSource!.skills.map((s) => s.name)).toContain("alpha");
    expect(input.loadedPaths).toContain(path.normalize(alphaFile));
    expect(
      input.settingsGlobal.some((e) => e.absPath === path.normalize(customRoot) && e.isDir),
    ).toBe(true);
  });

  it("excludes project-local settings and roots when project trust is inactive", async () => {
    const home = tmp("sf-gather-home-");
    const cwd = tmp("sf-gather-cwd-");
    const agentDir = path.join(home, ".pi", "agent");
    process.env[AGENT_DIR_ENV] = agentDir;

    const globalRoot = path.join(agentDir, "skills");
    const projectRoot = path.join(cwd, ".pi", "skills");
    const projectHarnessRoot = path.join(cwd, ".claude", "skills");
    writeSkill(globalRoot, "global-skill");
    writeSkill(projectRoot, "project-skill");
    writeSkill(projectHarnessRoot, "project-harness-skill");
    const projectConfig = nativeSkillSettingsPath("project", cwd);
    mkdirSync(path.dirname(projectConfig), { recursive: true });
    writeFileSync(
      projectConfig,
      YAML.stringify({ skills: { customDirectories: ["./.claude/skills"] } }),
    );

    const loadSkills = vi.fn(async () => ({
      skills: [],
      warnings: [],
    }));

    const input = await gatherCatalogInput({
      cwd,
      projectTrusted: false,
      deps: fakeDeps({ loadSkills }),
    });

    expect(loadSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        enablePiProject: false,
        enableClaudeProject: false,
        enableAgentsProject: false,
        customDirectories: [path.join(agentDir, "skills")],
      }),
    );
    expect(input.settingsProject).toEqual([]);
    expect(input.sources.some((s) => s.rootPath === path.normalize(projectRoot))).toBe(false);
    expect(input.sources.some((s) => s.rootPath === path.normalize(projectHarnessRoot))).toBe(
      false,
    );
    expect(input.sources.some((s) => s.rootPath === path.normalize(globalRoot))).toBe(true);
  });

  it("remembers a seen-but-empty registered custom source and gates it seen", async () => {
    const home = tmp("sf-gather-home-");
    const cwd = tmp("sf-gather-cwd-");
    process.env[AGENT_DIR_ENV] = path.join(home, ".pi", "agent");

    const customRoot = path.join(home, "team-skills");
    writeSkill(customRoot, "beta");
    upsertSource("global", { value: customRoot, kind: "custom", gate: "seen", label: "Team" });

    const input = await gatherCatalogInput({ cwd, deps: fakeDeps() });
    const src = input.sources.find((s) => s.rootPath === path.normalize(customRoot));
    expect(src).toBeDefined();
    expect(src!.gate).toBe("seen");
    expect(src!.kind).toBe("custom");
    expect(src!.skills.map((s) => s.name)).toContain("beta");
  });

  it("labels the managed afv-library install (not 'Unknown source'), even with per-file wiring", async () => {
    const home = tmp("sf-gather-home-");
    const cwd = tmp("sf-gather-cwd-");
    const agentDir = path.join(home, ".pi", "agent");
    process.env[AGENT_DIR_ENV] = agentDir;

    // afv-library cloned at the well-known global location, wired PER-FILE
    // (as expand-minus-one produces) rather than as a directory entry.
    const afvRoot = path.join(agentDir, "sf-skills", "afv-library", "skills");
    const f1 = writeSkill(afvRoot, "generating-apex");
    const f2 = writeSkill(afvRoot, "deploying-metadata");
    mkdirSync(agentDir, { recursive: true });
    updateSkillSources({ add: [f1, f2], remove: [], scope: "global", cwd });

    const input = await gatherCatalogInput({ cwd, deps: fakeDeps() });
    const afv = input.sources.find((s) => s.rootPath === path.normalize(afvRoot));
    expect(afv).toBeDefined();
    expect(afv!.kind).toBe("managed");
    expect(afv!.label).toBe("afv-library (legacy, global)");
    expect(afv!.gate).toBe("seen");
    expect(afv!.skills.map((s) => s.name).sort()).toEqual([
      "deploying-metadata",
      "generating-apex",
    ]);
    // None of these should land as an unknown/orphan source.
    expect(input.sources.some((s) => s.label.toLowerCase().includes("unknown"))).toBe(false);
  });

  it("keeps the managed afv-library source visible even when nothing is wired (no vanish)", async () => {
    const home = tmp("sf-gather-home-");
    const cwd = tmp("sf-gather-cwd-");
    const agentDir = path.join(home, ".pi", "agent");
    process.env[AGENT_DIR_ENV] = agentDir;

    // Clone exists on disk but skills.customDirectories is empty (all disabled).
    const afvRoot = path.join(agentDir, "sf-skills", "afv-library", "skills");
    writeSkill(afvRoot, "generating-apex");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      nativeSkillSettingsPath("global", cwd),
      YAML.stringify({ skills: { customDirectories: [] } }),
    );

    const input = await gatherCatalogInput({ cwd, deps: fakeDeps() });
    const afv = input.sources.find((s) => s.rootPath === path.normalize(afvRoot));
    expect(afv).toBeDefined();
    expect(afv!.gate).toBe("seen"); // managed install on disk stays visible
    expect(afv!.skills.map((s) => s.name)).toContain("generating-apex");
  });

  it("groups scanned duplicate copies even when native loader names are namespaced", async () => {
    const home = tmp("sf-gather-home-");
    const cwd = tmp("sf-gather-cwd-");
    const agentDir = path.join(home, ".pi", "agent");
    process.env[AGENT_DIR_ENV] = agentDir;
    const firstRoot = path.join(home, "first");
    const secondRoot = path.join(home, "second");
    const first = writeSkill(firstRoot, "dup");
    const second = writeSkill(secondRoot, "dup");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      nativeSkillSettingsPath("global", cwd),
      YAML.stringify({
        skills: { customDirectories: [firstRoot, secondRoot] },
      }),
    );

    const input = await gatherCatalogInput({
      cwd,
      deps: fakeDeps({
        loadSkills: async () => ({
          skills: [
            { name: "first:dup", filePath: first },
            { name: "second:dup", filePath: second },
          ],
          warnings: [],
        }),
      }),
    });
    const duplicate = buildSkillCatalog(input).conflicts.find((entry) => entry.name === "dup");
    expect(duplicate).toBeDefined();
    expect(duplicate!.copies.map((copy) => copy.filePath).sort()).toEqual([first, second].sort());
  });
});
