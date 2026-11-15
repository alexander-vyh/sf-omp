/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Tests for the prune planner + applier.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as YAML from "yaml";
import { nativeTestDir } from "./native-fixture.ts";
import { applyPrunePlan, buildPrunePlan } from "../lib/prune.ts";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function makeHome(): string {
  const dir = nativeTestDir("sf-skills-prune-home-");
  tempDirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
  return dir;
}

function makeCwd(): string {
  const dir = nativeTestDir("sf-skills-prune-cwd-");
  tempDirs.push(dir);
  return dir;
}

function writeGlobalSettings(home: string, customDirectories: string[]): string {
  const filePath = path.join(home, "agent", "config.yml");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, YAML.stringify({ skills: { customDirectories } }), "utf8");
  return filePath;
}

function writeSentinelManagedClone(home: string, name: string): string {
  const root = path.join(home, "agent", "sf-skills", name);
  mkdirSync(path.join(root, "skills"), { recursive: true });
  writeFileSync(path.join(root, ".sf-skills-managed"), "managed", "utf8");
  return root;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("buildPrunePlan", () => {
  it("returns empty when nothing is wired and no managed dirs exist", () => {
    process.env.HOME = makeHome();
    const plan = buildPrunePlan(makeCwd());
    expect(plan.staleWired).toEqual([]);
    expect(plan.orphanManagedDirs).toEqual([]);
  });

  it("flags settings entries whose paths no longer exist", () => {
    const home = makeHome();
    process.env.HOME = home;
    writeGlobalSettings(home, ["~/missing/dir", "~/.claude/skills"]);
    const plan = buildPrunePlan(makeCwd());
    expect(plan.staleWired).toContain("~/missing/dir");
  });

  it("flags managed clone dirs whose skills/ subdir is not referenced", () => {
    const home = makeHome();
    process.env.HOME = home;
    const root = writeSentinelManagedClone(home, "afv-library");
    // Wire something else, NOT this clone.
    writeGlobalSettings(home, ["~/.claude/skills"]);
    const plan = buildPrunePlan(makeCwd());
    expect(plan.orphanManagedDirs.map((o) => o.absolutePath)).toContain(root);
  });

  it("does not flag managed clones that ARE referenced", () => {
    const home = makeHome();
    process.env.HOME = home;
    const root = writeSentinelManagedClone(home, "afv-library");
    writeGlobalSettings(home, [path.join(root, "skills")]);
    const plan = buildPrunePlan(makeCwd());
    expect(plan.orphanManagedDirs).toEqual([]);
  });

  it("never flags user-owned dirs (no sentinel)", () => {
    const home = makeHome();
    process.env.HOME = home;
    // No sentinel — user-owned.
    const root = path.join(home, "agent", "sf-skills", "user-owned");
    mkdirSync(path.join(root, "skills"), { recursive: true });
    const plan = buildPrunePlan(makeCwd());
    expect(plan.orphanManagedDirs).toEqual([]);
  });
});

describe("applyPrunePlan", () => {
  it("removes stale entries from settings", () => {
    const home = makeHome();
    process.env.HOME = home;
    const settings = writeGlobalSettings(home, ["~/missing/dir", "~/.existing/skills"]);
    mkdirSync(path.join(home, ".existing", "skills"), { recursive: true });

    const plan = buildPrunePlan(makeCwd());
    const outcome = applyPrunePlan(plan, makeCwd(), {
      removeStale: true,
      deleteOrphans: false,
    });
    expect(outcome.staleRemoved).toBeGreaterThan(0);

    const next = YAML.parse(readFileSync(settings, "utf8"));
    expect(next.skills.customDirectories).not.toContain("~/missing/dir");
    expect(next.skills.customDirectories).toContain("~/.existing/skills");
  });

  it("deletes orphan managed dirs (sentinel-gated)", () => {
    const home = makeHome();
    process.env.HOME = home;
    const root = writeSentinelManagedClone(home, "afv-library");
    writeGlobalSettings(home, []);
    const plan = buildPrunePlan(makeCwd());
    const outcome = applyPrunePlan(plan, makeCwd(), {
      removeStale: false,
      deleteOrphans: true,
    });
    expect(outcome.dirsDeleted).toBe(1);
    expect(existsSync(root)).toBe(false);
  });
});
