/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Tests for the parent-dir auto-expand / no-op detection.
 *
 * The bugs these guard against are the two real ones we shipped in v1
 * and fixed:
 *
 *   1. Toggling enable at a different scope while a parent dir was
 *      already wired produced a duplicate-load warning. planEnable now
 *      returns alreadyCovered=true so the apply path can skip cleanly.
 *
 *   2. Toggling disable while a parent dir was wired silently did
 *      nothing. planDisable now returns coverage='parent' with the
 *      sibling expansion the apply path must write back.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { planDisable, planEnable } from "../lib/settings-coverage.ts";
import * as YAML from "yaml";
import { nativeSkillSettingsPath } from "../../../lib/common/skill-sources/skill-settings.ts";
import {
  updateSkillSources,
  type SkillSourceScope,
} from "../../../lib/common/skill-sources/skill-sources.ts";
import { nativeTestDir } from "./native-fixture.ts";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function makeHome(): string {
  const dir = nativeTestDir("sf-skills-cov-home-");
  tempDirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
  return dir;
}

function makeCwd(): string {
  const dir = nativeTestDir("sf-skills-cov-cwd-");
  tempDirs.push(dir);
  return dir;
}

function writeSettings(scope: SkillSourceScope, cwd: string, skills: string[]): void {
  const filePath = nativeSkillSettingsPath(scope, cwd);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, YAML.stringify({ skills: { customDirectories: [] } }), "utf8");
  // Individual files must use the native single-skill projection, not widen to their siblings.
  updateSkillSources({ add: skills, remove: [], scope, cwd });
}

function makeSkill(root: string, name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${name}\n---\n`, "utf8");
  return file;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("planDisable", () => {
  it("removes an exact file-path entry verbatim", () => {
    const home = makeHome();
    process.env.HOME = home;
    const root = path.join(home, ".claude", "skills");
    const skill = makeSkill(root, "demo");
    writeSettings("global", home, [skill]);

    const plan = planDisable({ skillPath: skill, scope: "global", cwd: makeCwd() });
    expect(plan.coverage).toBe("exact");
    expect(plan.remove).toEqual([skill]);
    expect(plan.add).toEqual([]);
  });

  it("expands a parent-dir entry into per-file entries minus the disabled one", () => {
    const home = makeHome();
    process.env.HOME = home;
    const root = path.join(home, ".claude", "skills");
    const a = makeSkill(root, "alpha");
    const b = makeSkill(root, "beta");
    const c = makeSkill(root, "gamma");
    writeSettings("global", home, ["~/.claude/skills"]);

    const plan = planDisable({ skillPath: b, scope: "global", cwd: makeCwd() });
    expect(plan.coverage).toBe("parent");
    expect(plan.remove).toEqual([root]);
    // Order isn't guaranteed by readdirSync — sort for stable assertion.
    expect([...plan.add].sort()).toEqual([a, c].sort());
    expect(plan.expandedFrom).toBe(root);
    expect(plan.expandedSiblingCount).toBe(2);
  });

  it("returns coverage='none' when neither the file nor a parent is wired", () => {
    const home = makeHome();
    process.env.HOME = home;
    // Skill exists, but no settings entry covers it (auto-discovered case).
    const skill = makeSkill(path.join(home, "agent", "skills"), "auto");
    const plan = planDisable({ skillPath: skill, scope: "global", cwd: makeCwd() });
    expect(plan.coverage).toBe("none");
    expect(plan.remove).toEqual([]);
    expect(plan.add).toEqual([]);
  });

  it("scopes correctly when called with scope='project'", () => {
    const home = makeHome();
    process.env.HOME = home;
    const cwd = makeCwd();
    const root = path.join(cwd, ".claude", "skills");
    const skill = makeSkill(root, "demo");
    writeSettings("project", cwd, ["./.claude/skills"]);

    const plan = planDisable({ skillPath: skill, scope: "project", cwd });
    expect(plan.coverage).toBe("parent");
    expect(plan.remove).toEqual([root]);
    expect(plan.add).toEqual([]); // only one skill under the parent
  });
});

describe("planEnable", () => {
  it("returns alreadyCovered when the file path is in settings verbatim", () => {
    const home = makeHome();
    process.env.HOME = home;
    const root = path.join(home, ".claude", "skills");
    const skill = makeSkill(root, "demo");
    const sibling = makeSkill(root, "sibling");
    writeSettings("global", home, [skill]);

    const plan = planEnable({ skillPath: skill, scope: "global", cwd: makeCwd() });
    expect(plan.alreadyCovered).toBe(true);
    expect(plan.coveredInScope).toBe("global");
    expect(plan.add).toEqual([]);
    const siblingPlan = planEnable({ skillPath: sibling, scope: "global", cwd: makeCwd() });
    expect(siblingPlan.alreadyCovered).toBe(false);
    expect(siblingPlan.add).toEqual([sibling]);
  });

  it("returns alreadyCovered when a parent dir entry covers the file", () => {
    const home = makeHome();
    process.env.HOME = home;
    const root = path.join(home, ".claude", "skills");
    const skill = makeSkill(root, "demo");
    writeSettings("global", home, ["~/.claude/skills"]);

    const plan = planEnable({ skillPath: skill, scope: "global", cwd: makeCwd() });
    expect(plan.alreadyCovered).toBe(true);
    expect(plan.coveredInScope).toBe("global");
    expect(plan.add).toEqual([]);
  });

  it("queues the file path for add when nothing covers it", () => {
    const home = makeHome();
    process.env.HOME = home;
    const root = path.join(home, ".claude", "skills");
    const skill = makeSkill(root, "demo");
    // Settings empty.
    writeSettings("global", home, []);

    const plan = planEnable({ skillPath: skill, scope: "global", cwd: makeCwd() });
    expect(plan.alreadyCovered).toBe(false);
    expect(plan.coveredInScope).toBeUndefined();
    expect(plan.add).toEqual([skill]);
  });

  // Regression: enabling at scope B while scope A already covers the
  // skill used to silently append the file path, producing pi's
  // name-collision warning on reload. Now we detect cross-scope cover.
  it("detects cross-scope coverage (global wired, project toggle)", () => {
    const home = makeHome();
    process.env.HOME = home;
    const cwd = makeCwd();
    const root = path.join(home, ".claude", "skills");
    const skill = makeSkill(root, "demo");
    writeSettings("global", cwd, ["~/.claude/skills"]);
    writeSettings("project", cwd, []);

    const plan = planEnable({ skillPath: skill, scope: "project", cwd });
    expect(plan.alreadyCovered).toBe(true);
    expect(plan.coveredInScope).toBe("global");
    expect(plan.add).toEqual([]);
  });

  it("detects cross-scope coverage the other direction (project wired, global toggle)", () => {
    const home = makeHome();
    process.env.HOME = home;
    const cwd = makeCwd();
    const root = path.join(cwd, ".claude", "skills");
    const skill = makeSkill(root, "demo");
    writeSettings("project", cwd, ["./.claude/skills"]);

    const plan = planEnable({ skillPath: skill, scope: "global", cwd });
    expect(plan.alreadyCovered).toBe(true);
    expect(plan.coveredInScope).toBe("project");
    expect(plan.add).toEqual([]);
  });
});
