/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Unit tests for pi-compat: the semver-ish comparator and the factory-time
 * gate, which honours the SF Pi Manager's OMP-native `disabledExtensions`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as YAML from "yaml";
import { compareVersions, requirePiVersion } from "../pi-compat.ts";

describe("compareVersions", () => {
  it("returns 0 for equal full-release versions", () => {
    expect(compareVersions("0.72.0", "0.72.0")).toBe(0);
  });

  it("orders patch releases correctly", () => {
    expect(compareVersions("0.72.1", "0.72.0")).toBeGreaterThan(0);
    expect(compareVersions("0.72.0", "0.72.1")).toBeLessThan(0);
  });

  it("orders minor releases correctly", () => {
    expect(compareVersions("0.72.0", "0.71.9")).toBeGreaterThan(0);
    expect(compareVersions("0.70.6", "0.72.0")).toBeLessThan(0);
  });

  it("treats a prerelease as older than the same core full release", () => {
    // Matches how our gate should interpret "0.72.0-rc.1" < "0.72.0".
    expect(compareVersions("0.72.0-rc.1", "0.72.0")).toBeLessThan(0);
    expect(compareVersions("0.72.0", "0.72.0-rc.1")).toBeGreaterThan(0);
  });

  it("ignores SemVer build metadata, including hyphens", () => {
    expect(compareVersions("0.82.0+build-1", "0.82.0")).toBe(0);
  });

  it("pads short inputs with zeroes so '0.72' == '0.72.0'", () => {
    expect(compareVersions("0.72", "0.72.0")).toBe(0);
  });
});

describe("requirePiVersion", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const tempDirs: string[] = [];
  let agentDir = "";

  beforeEach(() => {
    // Native global config refuses paths outside this checkout's .runtime directory.
    const root = fileURLToPath(new URL("../../../.runtime/skill-tests/", import.meta.url));
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, "pi-compat-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-compat-cwd-"));
    tempDirs.push(dir, cwd);
    agentDir = path.join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // No project `.omp/config.yml` from the runner's cwd may override global config.
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("loads every extension when the OMP config disables none", () => {
    expect(requirePiVersion({}, "sf-slack")).toBe(true);
  });

  it("skips only the extension the manager disabled in the OMP config", () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, "config.yml"),
      YAML.stringify({ disabledExtensions: ["extension-module:sf-slack"] }),
    );

    expect(requirePiVersion({}, "sf-slack")).toBe(false);
    expect(requirePiVersion({}, "sf-apex")).toBe(true);
  });
});
