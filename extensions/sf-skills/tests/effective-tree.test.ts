/* SPDX-License-Identifier: Apache-2.0 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyInvocationMode } from "../lib/invocation/frontmatter.ts";
import {
  ensureEffectiveSkills,
  inspectEffectiveSkills,
  managedCloneRoot,
  managedEffectiveSkillsPath,
  syncEffectiveSkills,
} from "../lib/invocation/effective-tree.ts";
import type { SkillInvocationPolicy } from "../lib/invocation/types.ts";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function makeHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-skills-effective-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeSkill(root: string, name: string, extra = ""): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  writeFileSync(
    file,
    `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\nbody for ${name}\n`,
  );
  return file;
}

describe("effective tree", () => {
  it("copies the clone and stamps effective files without touching the clone", () => {
    const home = makeHome();
    process.env.HOME = home;
    const cloneSkills = path.join(home, "clone", "skills");
    const cloneFile = writeSkill(cloneSkills, "platform-apex-generate");
    writeSkill(cloneSkills, "dx-org-switch");

    const policy: SkillInvocationPolicy = {
      default: "manual-only",
      packs: { platform: "agent-invocable" },
      skills: {},
    };
    const result = syncEffectiveSkills(cloneSkills, policy);
    expect(result.copied).toBe(2);
    expect(classifyInvocationMode(readFileSync(cloneFile, "utf8"))).toBe("agent-invocable");

    const effectiveApex = path.join(
      home,
      ".pi",
      "agent",
      "sf-skills",
      "effective",
      "skills",
      "platform-apex-generate",
      "SKILL.md",
    );
    const effectiveDx = path.join(
      home,
      ".pi",
      "agent",
      "sf-skills",
      "effective",
      "skills",
      "dx-org-switch",
      "SKILL.md",
    );
    expect(classifyInvocationMode(readFileSync(effectiveApex, "utf8"))).toBe("agent-invocable");
    expect(classifyInvocationMode(readFileSync(effectiveDx, "utf8"))).toBe("manual-only");
    expect(readFileSync(effectiveDx, "utf8")).toContain("body for dx-org-switch");
  });

  it("preserves author disable-model-invocation from the clone", () => {
    const home = makeHome();
    process.env.HOME = home;
    const cloneSkills = path.join(home, "clone", "skills");
    writeSkill(cloneSkills, "secret-skill", "disable-model-invocation: true\n");
    const result = syncEffectiveSkills(cloneSkills, {
      default: "agent-invocable",
      packs: {},
      skills: { "secret-skill": "agent-invocable" },
    });
    expect(result.skills[0]?.authorDisabled).toBe(true);
    expect(result.skills[0]?.desiredMode).toBe("manual-only");
    expect(classifyInvocationMode(readFileSync(result.skills[0]!.effectiveFile, "utf8"))).toBe(
      "manual-only",
    );
  });

  it("replaces deleted upstream skills on resync", () => {
    const home = makeHome();
    process.env.HOME = home;
    const cloneSkills = path.join(home, "clone", "skills");
    writeSkill(cloneSkills, "keep-me");
    writeSkill(cloneSkills, "drop-me");
    syncEffectiveSkills(cloneSkills, { default: "manual-only", packs: {}, skills: {} });
    rmSync(path.join(cloneSkills, "drop-me"), { recursive: true, force: true });
    syncEffectiveSkills(cloneSkills, { default: "manual-only", packs: {}, skills: {} });
    expect(
      readFileSync(
        path.join(home, ".pi", "agent", "sf-skills", "effective", "skills", "keep-me", "SKILL.md"),
        "utf8",
      ),
    ).toContain("keep-me");
    expect(() =>
      readFileSync(
        path.join(home, ".pi", "agent", "sf-skills", "effective", "skills", "drop-me", "SKILL.md"),
        "utf8",
      ),
    ).toThrow();
  });
  it("keeps the existing effective tree and warns when the clone skills path is missing", () => {
    const home = makeHome();
    process.env.HOME = home;
    const cloneSkills = path.join(home, "clone", "skills");
    writeSkill(cloneSkills, "keep-me");
    const initial = syncEffectiveSkills(cloneSkills);
    const effectiveFile = initial.skills[0]!.effectiveFile;
    const original = readFileSync(effectiveFile, "utf8");
    rmSync(cloneSkills, { recursive: true });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      syncEffectiveSkills(cloneSkills);
      expect(readFileSync(effectiveFile, "utf8")).toBe(original);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(cloneSkills));
    } finally {
      warning.mockRestore();
    }
  });

  it("uses one overridden agent root and skips an unchanged effective tree", () => {
    const home = makeHome();
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = path.join(home, "runtime", "agent");
    const cloneSkills = path.join(managedCloneRoot(), "skills");
    writeSkill(cloneSkills, "sample-skill");
    expect(managedEffectiveSkillsPath()).toBe(
      path.join(process.env.PI_CODING_AGENT_DIR, "sf-skills", "effective", "skills"),
    );
    expect(inspectEffectiveSkills()).toBe("missing");
    expect(ensureEffectiveSkills()?.copied).toBe(1);
    expect(inspectEffectiveSkills()).toBe("ready");
    expect(ensureEffectiveSkills()).toBeUndefined();
    rmSync(managedEffectiveSkillsPath(), { recursive: true });
    mkdirSync(managedEffectiveSkillsPath());
    expect(inspectEffectiveSkills()).toBe("empty");
    expect(ensureEffectiveSkills()?.copied).toBe(1);
    expect(inspectEffectiveSkills()).toBe("ready");
  });

  it("keeps an existing tree when first-turn repair has no clone", () => {
    const home = makeHome();
    process.env.HOME = home;
    const effectiveFile = writeSkill(managedEffectiveSkillsPath(), "keep-me");
    expect(inspectEffectiveSkills()).toBe("missing-clone");
    expect(ensureEffectiveSkills()).toBeUndefined();
    expect(readFileSync(effectiveFile, "utf8")).toContain("keep-me");
  });
});
