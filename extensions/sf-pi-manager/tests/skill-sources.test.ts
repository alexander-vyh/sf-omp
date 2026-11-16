/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Tests for the skill-sources detector + settings writer.
 *
 * Covers disk detection across ~/.claude, ~/.codex, ~/.cursor, the
 * wired-vs-available cross-reference with native OMP YAML
 * `skills.customDirectories` (global `<agentDir>/config.yml`, project
 * `<cwd>/.omp/config.yml`), and the idempotent add/remove semantics of
 * updateSkillSources().
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";
import {
  detectSkillSources,
  updateSkillSources,
} from "../../../lib/common/skill-sources/skill-sources.ts";
import { parseSkillsArgs } from "../lib/skill-sources-command.ts";

const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];
let agentDir = "";

// Global native settings refuse paths outside this checkout's .runtime directory,
// so each test gets an isolated agent dir there instead of the real runtime.
function nativeTestDir(prefix: string): string {
  const root = fileURLToPath(new URL("../../../.runtime/skill-tests/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, prefix));
  tempDirs.push(dir);
  return dir;
}

function makeHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-skill-sources-home-"));
  tempDirs.push(dir);
  return dir;
}

function makeCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-skill-sources-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function globalConfigPath(): string {
  return path.join(agentDir, "config.yml");
}

function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".omp", "config.yml");
}

function writeConfig(filePath: string, body: Record<string, unknown>): string {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, YAML.stringify(body), "utf8");
  return filePath;
}

function writeSkillDirectories(filePath: string, customDirectories: string[]): string {
  return writeConfig(filePath, { skills: { customDirectories } });
}

function readConfig(filePath: string): Record<string, unknown> {
  return YAML.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function customDirectories(filePath: string): unknown {
  return (readConfig(filePath).skills as { customDirectories?: unknown }).customDirectories;
}

beforeEach(() => {
  agentDir = path.join(nativeTestDir("sf-pi-manager-skill-sources-"), "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("detectSkillSources", () => {
  it("returns no candidates when no external roots exist", () => {
    const home = makeHome();
    process.env.HOME = home;

    const result = detectSkillSources(home);
    expect(result.candidates).toEqual([]);
    expect(result.staleWired).toEqual([]);
    expect(result.settingsPath).toBe(globalConfigPath());
  });

  it("detects Claude, Codex, and Cursor roots with OMP skill counts", () => {
    const home = makeHome();
    process.env.HOME = home;

    // Claude: two dir-based skills, one loose .md (OMP scans child SKILL.md dirs only)
    mkdirSync(path.join(home, ".claude", "skills", "skill-one"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "skills", "skill-one", "SKILL.md"), "---\n");
    mkdirSync(path.join(home, ".claude", "skills", "skill-two"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "skills", "skill-two", "SKILL.md"), "---\n");
    writeFileSync(path.join(home, ".claude", "skills", "loose.md"), "# loose skill\n");

    // Codex: empty dir (still counts as a candidate, zero skills)
    mkdirSync(path.join(home, ".codex", "skills"), { recursive: true });

    // No Cursor dir on purpose

    const result = detectSkillSources(home);
    const labels = result.candidates.map((c) => c.label);
    expect(labels).toEqual(["Claude Code", "OpenAI Codex"]);

    const claude = result.candidates.find((c) => c.label === "Claude Code")!;
    expect(claude.skillCount).toBe(2);
    expect(claude.settingsPath).toBe("~/.claude/skills");
    expect(claude.wired).toBe(false);
  });

  it("flags a root as wired when customDirectories contains the ~-prefixed path", () => {
    const home = makeHome();
    process.env.HOME = home;
    mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    writeSkillDirectories(globalConfigPath(), ["~/.claude/skills"]);

    const result = detectSkillSources(home);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.wired).toBe(true);
  });

  it("matches wired entries across path shapes (absolute vs ~)", () => {
    // User wrote the absolute form in settings but we detect via ~
    // conventions. The cross-form comparison must still flag this as wired.
    const home = makeHome();
    process.env.HOME = home;
    const absoluteClaude = path.join(home, ".claude", "skills");
    mkdirSync(absoluteClaude, { recursive: true });
    writeSkillDirectories(globalConfigPath(), [absoluteClaude]);

    const result = detectSkillSources(home);
    expect(result.candidates[0]!.wired).toBe(true);
  });

  it("reports stale wired entries whose paths no longer exist", () => {
    const home = makeHome();
    process.env.HOME = home;
    writeSkillDirectories(globalConfigPath(), ["~/.claude/skills", "~/some/missing/dir"]);

    const result = detectSkillSources(home);
    expect(result.staleWired).toContain("~/.claude/skills");
    expect(result.staleWired).toContain("~/some/missing/dir");
  });

  it("does not inspect project-scope candidates when project scope is excluded", () => {
    const home = makeHome();
    process.env.HOME = home;
    const cwd = makeCwd();
    mkdirSync(path.join(cwd, ".claude", "skills", "my-skill"), { recursive: true });
    writeFileSync(
      path.join(cwd, ".claude", "skills", "my-skill", "SKILL.md"),
      "---\nname: my-skill\n---\n",
    );
    writeSkillDirectories(projectConfigPath(cwd), ["./missing-project-skills"]);

    const result = detectSkillSources({ home, cwd, includeProject: false });

    expect(result.projectIncluded).toBe(false);
    expect(result.projectSettingsPath).toBeUndefined();
    expect(result.candidates.some((c) => c.scope === "project")).toBe(false);
    expect(result.staleWired).not.toContain("./missing-project-skills");
  });

  it("detects project-scope candidates when cwd is supplied", () => {
    const home = makeHome();
    process.env.HOME = home;
    const cwd = makeCwd();
    mkdirSync(path.join(cwd, ".claude", "skills", "my-skill"), { recursive: true });
    writeFileSync(
      path.join(cwd, ".claude", "skills", "my-skill", "SKILL.md"),
      "---\nname: my-skill\n---\n",
    );

    const result = detectSkillSources({ home, cwd });
    const labels = result.candidates.map((c) => c.label);
    expect(labels).toContain("Claude Code (project)");
    expect(result.projectSettingsPath).toBe(projectConfigPath(cwd));
    const project = result.candidates.find((c) => c.scope === "project");
    expect(project?.skillCount).toBe(1);
    expect(project?.wired).toBe(false);
  });

  it("distinguishes wiring per scope", () => {
    const home = makeHome();
    process.env.HOME = home;
    const cwd = makeCwd();
    // Both global ~/.claude/skills and project ./.claude/skills exist.
    mkdirSync(path.join(home, ".claude", "skills", "global-skill"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude", "skills", "global-skill", "SKILL.md"),
      "---\nname: global-skill\n---\n",
    );
    mkdirSync(path.join(cwd, ".claude", "skills", "project-skill"), { recursive: true });
    writeFileSync(
      path.join(cwd, ".claude", "skills", "project-skill", "SKILL.md"),
      "---\nname: project-skill\n---\n",
    );

    // Wire the project candidate in project settings only.
    writeSkillDirectories(projectConfigPath(cwd), ["./.claude/skills"]);

    const result = detectSkillSources({ home, cwd });
    const global = result.candidates.find((c) => c.scope === "global");
    const project = result.candidates.find((c) => c.scope === "project");
    expect(global?.wired).toBe(false);
    expect(project?.wired).toBe(true);
  });
});

describe("updateSkillSources", () => {
  it("appends new skills paths and preserves unrelated native settings", () => {
    const home = makeHome();
    process.env.HOME = home;
    writeConfig(globalConfigPath(), {
      setupVersion: 3,
      skills: { customDirectories: ["~/.existing/skills"], ignoredSkills: ["noisy"] },
    });

    const updated = updateSkillSources({ add: ["~/.claude/skills"], remove: [], home });
    expect(updated.settingsPath).toBe(globalConfigPath());
    expect(updated.skills).toEqual(["~/.existing/skills", "~/.claude/skills"]);

    const disk = readConfig(globalConfigPath());
    expect(disk.skills).toEqual({
      customDirectories: ["~/.existing/skills", "~/.claude/skills"],
      ignoredSkills: ["noisy"],
    });
    expect(disk.setupVersion).toBe(3);
  });

  it("creates the native config file when none exists", () => {
    const home = makeHome();
    process.env.HOME = home;

    const updated = updateSkillSources({ add: ["~/.claude/skills"], remove: [], home });
    expect(updated.skills).toEqual(["~/.claude/skills"]);

    expect(readConfig(globalConfigPath())).toEqual({
      skills: { customDirectories: ["~/.claude/skills"] },
    });
  });

  it("is idempotent when adding a path already present", () => {
    const home = makeHome();
    process.env.HOME = home;
    const filePath = writeSkillDirectories(globalConfigPath(), ["~/.claude/skills"]);
    const before = readFileSync(filePath, "utf8");

    updateSkillSources({ add: ["~/.claude/skills"], remove: [], home });

    expect(readFileSync(filePath, "utf8")).toBe(before);
  });

  it("removes an entry matched by its raw value", () => {
    const home = makeHome();
    process.env.HOME = home;
    writeSkillDirectories(globalConfigPath(), ["~/.claude/skills", "~/.codex/skills"]);

    updateSkillSources({ add: [], remove: ["~/.claude/skills"], home });

    expect(customDirectories(globalConfigPath())).toEqual(["~/.codex/skills"]);
  });

  it("removes an entry matched by resolved absolute path", () => {
    // Users can pass the absolute form; we should still drop the ~ variant
    // from settings to avoid leaving a duplicate behind.
    const home = makeHome();
    process.env.HOME = home;
    writeSkillDirectories(globalConfigPath(), ["~/.claude/skills"]);

    const absolute = path.join(home, ".claude", "skills");
    updateSkillSources({ add: [], remove: [absolute], home });

    expect(customDirectories(globalConfigPath())).toEqual([]);
  });

  it("writes to the project config when scope is 'project', resolving against cwd", () => {
    const home = makeHome();
    process.env.HOME = home;
    const cwd = makeCwd();

    const updated = updateSkillSources({
      add: ["./.claude/skills"],
      remove: [],
      scope: "project",
      cwd,
      home,
    });
    const absolute = path.join(cwd, ".claude", "skills");
    expect(updated.settingsPath).toBe(projectConfigPath(cwd));
    expect(updated.skills).toEqual([absolute]);
    expect(customDirectories(updated.settingsPath)).toEqual([absolute]);

    // Global settings should remain untouched.
    expect(existsSync(globalConfigPath())).toBe(false);
  });

  it("throws when scope='project' is used without cwd", () => {
    const home = makeHome();
    process.env.HOME = home;
    expect(() =>
      updateSkillSources({ add: ["./.claude/skills"], remove: [], scope: "project", home }),
    ).toThrow(/require cwd/);
  });

  it("refuses to write a settings file other than the native OMP config", () => {
    const home = makeHome();
    process.env.HOME = home;
    const legacy = path.join(home, ".pi", "agent", "settings.json");
    expect(() =>
      updateSkillSources({ add: ["~/.claude/skills"], remove: [], home, settingsFile: legacy }),
    ).toThrow(/native OMP config/);
    expect(existsSync(legacy)).toBe(false);
  });
});

describe("parseSkillsArgs", () => {
  it("maps empty input to overlay", () => {
    expect(parseSkillsArgs("")).toEqual({ subcommand: "overlay" });
  });

  it("recognizes list / status / link / unlink", () => {
    expect(parseSkillsArgs("list").subcommand).toBe("list");
    expect(parseSkillsArgs("ls").subcommand).toBe("list");
    expect(parseSkillsArgs("status").subcommand).toBe("status");
    expect(parseSkillsArgs("link ~/.claude/skills")).toEqual({
      subcommand: "link",
      target: "~/.claude/skills",
    });
    expect(parseSkillsArgs("unlink Claude Code")).toEqual({
      subcommand: "unlink",
      target: "Claude Code",
    });
    expect(parseSkillsArgs("rm ~/.codex/skills")).toEqual({
      subcommand: "unlink",
      target: "~/.codex/skills",
    });
  });

  it("falls back to overlay for unknown subcommands", () => {
    expect(parseSkillsArgs("frobnicate")).toEqual({ subcommand: "overlay" });
  });
});
