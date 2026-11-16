/* SPDX-License-Identifier: Apache-2.0 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findSkillCollisions } from "../doctor/diagnostics.ts";
import type { SkillLocation } from "../doctor/types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function skill(root: string, name: string): string {
  const file = path.join(root, name, "SKILL.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\nname: ${name}\ndescription: test\n---\n`);
  return file;
}

function location(root: string, name: string, kind: SkillLocation["rootKind"]): SkillLocation {
  return {
    name,
    file: path.join(root, name, "SKILL.md"),
    root,
    rootLabel: kind,
    rootKind: kind,
    settingsValue: undefined,
  };
}

describe("findSkillCollisions", () => {
  it("does not count harness roots that link to the same skill as a collision", () => {
    const home = mkdtempSync(path.join(tmpdir(), "skill-collisions-"));
    dirs.push(home);
    const shared = path.join(home, "shared");
    skill(shared, "twg");
    for (const root of ["claude", "agents"]) {
      mkdirSync(path.join(home, root), { recursive: true });
      symlinkSync(path.join(shared, "twg"), path.join(home, root, "twg"));
    }

    const collisions = findSkillCollisions([
      location(path.join(home, "claude"), "twg", "claude"),
      location(path.join(home, "agents"), "twg", "agents"),
    ]);

    expect(collisions).toEqual([]);
  });

  it("still reports distinct skill files that share a name", () => {
    const home = mkdtempSync(path.join(tmpdir(), "skill-collisions-"));
    dirs.push(home);
    skill(path.join(home, "claude"), "deploy");
    skill(path.join(home, "agents"), "deploy");

    const collisions = findSkillCollisions([
      location(path.join(home, "claude"), "deploy", "claude"),
      location(path.join(home, "agents"), "deploy", "agents"),
    ]);

    expect(collisions.map((collision) => collision.name)).toEqual(["deploy"]);
    expect(collisions[0]?.duplicates).toHaveLength(1);
  });
});
