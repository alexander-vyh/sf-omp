/* SPDX-License-Identifier: Apache-2.0 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as YAML from "yaml";
import { getInstalledPiVersion } from "../../pi-compat.ts";
import { globalSettingsPath } from "../../pi-paths.ts";
import { nativeSkillSettingsPath, skillAgentDir } from "../../skill-sources/skill-settings.ts";
import { runDoctorDiagnostics } from "../diagnostics.ts";
import { applyDoctorFixes, repairStartupSettings } from "../fixes.ts";

const originalHome = process.env.HOME;
const tempDirs: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-pi-doctor-home-"));
  tempDirs.push(dir);
  process.env.HOME = dir;
  return dir;
}

function makeCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-pi-doctor-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(dir: string, name: string): void {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(
    path.join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} test skill\n---\n`,
    "utf8",
  );
}

function writeSettings(body: Record<string, unknown>): string {
  const file = globalSettingsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return file;
}

/** Global native OMP config, where `skills.customDirectories` lives. */
function writeOmpConfig(body: Record<string, unknown>): string {
  const file = nativeSkillSettingsPath("global");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, YAML.stringify(body), "utf8");
  return file;
}

function readCustomDirectories(): unknown {
  const config = YAML.parse(readFileSync(nativeSkillSettingsPath("global"), "utf8"));
  return config.skills.customDirectories;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DOCTOR_TEST_TIMEOUT_MS = 20_000;

describe("runDoctorDiagnostics", () => {
  it(
    "detects duplicate Salesforce skills and prefers Claude as source of truth",
    () => {
      const home = makeHome();
      const cwd = makeCwd();
      writeOmpConfig({ skills: { customDirectories: ["~/.claude/skills"] } });
      writeSkill(path.join(skillAgentDir(), "skills"), "sf-soql");
      writeSkill(path.join(home, ".claude", "skills"), "sf-soql");

      const report = runDoctorDiagnostics({ cwd, home });

      expect(report.skillCollisions).toHaveLength(1);
      expect(report.skillCollisions[0]!.name).toBe("sf-soql");
      expect(report.skillCollisions[0]!.preferred.rootKind).toBe("claude");
      expect(report.skillCollisions[0]!.duplicates[0]!.rootKind).toBe("omp");
      expect(report.issues.some((issue) => issue.id === "skill-collisions")).toBe(true);
    },
    DOCTOR_TEST_TIMEOUT_MS,
  );

  it(
    "detects stale and available external skill roots from OMP config",
    () => {
      const home = makeHome();
      const cwd = makeCwd();
      writeOmpConfig({ skills: { customDirectories: ["~/missing/skills"] } });
      writeSkill(path.join(home, ".claude", "skills"), "sf-apex");

      const report = runDoctorDiagnostics({ cwd, home });

      expect(report.staleSkillPaths).toEqual([
        { raw: "~/missing/skills", resolved: path.join(home, "missing", "skills") },
      ]);
      expect(report.availableSkillRoots.map((root) => root.settingsPath)).toEqual([
        "~/.claude/skills",
      ]);
    },
    DOCTOR_TEST_TIMEOUT_MS,
  );

  it(
    "treats a Pi settings.json skills[] array as unwired",
    () => {
      const home = makeHome();
      const cwd = makeCwd();
      writeSettings({ skills: ["~/missing/skills", "~/.claude/skills"] });
      writeSkill(path.join(home, ".claude", "skills"), "sf-apex");

      const report = runDoctorDiagnostics({ cwd, home });

      expect(report.staleSkillPaths).toEqual([]);
      expect(report.availableSkillRoots.map((root) => root.settingsPath)).toEqual([
        "~/.claude/skills",
      ]);
    },
    DOCTOR_TEST_TIMEOUT_MS,
  );

  it(
    "reports the SF Pi header welcome mode without warning about the overlay",
    () => {
      const home = makeHome();
      const cwd = makeCwd();
      writeSettings({ sfPi: { welcome: { mode: "header" } } });

      const report = runDoctorDiagnostics({ cwd, home });

      expect(report.welcomeMode).toBe("header");
      expect(report.issues.some((issue) => issue.id === "startup-overlay-enabled")).toBe(false);
    },
    DOCTOR_TEST_TIMEOUT_MS,
  );

  it(
    "reports the OMP host runtime from in-process facts",
    () => {
      const home = makeHome();
      const cwd = makeCwd();

      const report = runDoctorDiagnostics({ cwd, home });

      expect(report.runtime).toEqual({
        ompVersion: getInstalledPiVersion(),
        nodeVersion: process.version,
        nodePath: process.execPath,
      });
      expect(report.ompVersion).toBe(report.runtime.ompVersion);
    },
    DOCTOR_TEST_TIMEOUT_MS,
  );
});

describe("doctor fixes", () => {
  it("repairs startup settings without touching other keys", () => {
    makeHome();
    const settings = writeSettings({ theme: "dark", sfPi: { asciiIcons: true } });

    expect(repairStartupSettings(settings)).toBe(true);

    const disk = JSON.parse(readFileSync(settings, "utf8"));
    expect(disk.theme).toBe("dark");
    expect(disk).not.toHaveProperty("quietStartup");
    expect(disk.sfPi.asciiIcons).toBe(true);
    expect(disk.sfPi.welcome.mode).toBe("header");
  });

  it(
    "prunes stale and links available skill roots in the OMP config it checked",
    () => {
      const home = makeHome();
      const cwd = makeCwd();
      writeOmpConfig({ theme: "dark", skills: { customDirectories: ["~/missing/skills"] } });
      writeSkill(path.join(home, ".claude", "skills"), "sf-apex");

      const result = applyDoctorFixes({
        cwd,
        home,
        fixStaleSkillPaths: true,
        fixSkillLinks: true,
      });

      expect(result.changed).toBe(true);
      expect(readCustomDirectories()).toEqual(["~/.claude/skills"]);
      expect(YAML.parse(readFileSync(nativeSkillSettingsPath("global"), "utf8")).theme).toBe(
        "dark",
      );
      const after = runDoctorDiagnostics({ cwd, home });
      expect(after.staleSkillPaths).toEqual([]);
      expect(after.availableSkillRoots).toEqual([]);
    },
    DOCTOR_TEST_TIMEOUT_MS,
  );

  it(
    "quarantines duplicate sf skills from OMP-owned roots and keeps Claude",
    () => {
      const home = makeHome();
      const cwd = makeCwd();
      writeOmpConfig({ skills: { customDirectories: ["~/.claude/skills"] } });
      const ompRoot = path.join(skillAgentDir(), "skills");
      const claudeRoot = path.join(home, ".claude", "skills");
      writeSkill(ompRoot, "sf-testing");
      writeSkill(claudeRoot, "sf-testing");

      const result = applyDoctorFixes({
        cwd,
        home,
        fixSkills: true,
        now: new Date("2026-05-04T16:30:00Z"),
      });

      expect(result.changed).toBe(true);
      expect(result.quarantinedSkills).toHaveLength(1);
      expect(existsSync(path.join(ompRoot, "sf-testing"))).toBe(false);
      expect(existsSync(path.join(claudeRoot, "sf-testing", "SKILL.md"))).toBe(true);
      expect(
        result.quarantineDir?.startsWith(path.join(skillAgentDir(), "skills-quarantine")),
      ).toBe(true);
      expect(
        result.quarantineDir && existsSync(path.join(result.quarantineDir, "manifest.json")),
      ).toBe(true);
    },
    DOCTOR_TEST_TIMEOUT_MS,
  );
});
