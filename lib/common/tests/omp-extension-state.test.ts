/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as YAML from "yaml";
import {
  ompConfigPath,
  readOmpDisabledExtensionFiles,
  resolveOmpConfigScope,
  writeOmpDisabledExtensionFiles,
} from "../omp-extension-state.ts";
import { isExtensionDisabledInOmpConfig } from "../sf-pi-extension-state.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];
let agentDir = "";
let cwd = "";

// Native global config refuses paths outside this checkout's .runtime directory.
function runtimeTestDir(prefix: string): string {
  const root = fileURLToPath(new URL("../../../.runtime/skill-tests/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, prefix));
  tempDirs.push(dir);
  return dir;
}

function writeYaml(filePath: string, body: Record<string, unknown>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, YAML.stringify(body), "utf8");
}

function readYaml(filePath: string): Record<string, unknown> {
  return YAML.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  agentDir = path.join(runtimeTestDir("omp-extension-state-"), "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  cwd = mkdtempSync(path.join(tmpdir(), "omp-extension-state-cwd-"));
  tempDirs.push(cwd);
});

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("OMP-native extension enablement", () => {
  it("uses the native OMP YAML config paths", () => {
    expect(ompConfigPath("global", cwd)).toBe(path.join(agentDir, "config.yml"));
    expect(ompConfigPath("project", cwd)).toBe(path.join(cwd, ".omp", "config.yml"));
  });

  it("treats missing config as everything enabled in global scope", () => {
    expect(resolveOmpConfigScope(cwd)).toBe("global");
    expect(readOmpDisabledExtensionFiles(cwd)).toEqual(new Set());
    expect(isExtensionDisabledInOmpConfig("sf-slack", cwd)).toBe(false);
  });

  it("reads bundled extension-module entries and ignores foreign entries", () => {
    writeYaml(path.join(agentDir, "config.yml"), {
      disabledExtensions: ["extension-module:sf-slack", "extension-module:other", "skill:noisy"],
    });

    expect(readOmpDisabledExtensionFiles(cwd)).toEqual(new Set(["extensions/sf-slack/index.ts"]));
    expect(isExtensionDisabledInOmpConfig("sf-slack", cwd)).toBe(true);
    expect(isExtensionDisabledInOmpConfig("sf-apex", cwd)).toBe(false);
  });

  it("never reports alwaysActive extensions as disabled", () => {
    writeYaml(path.join(agentDir, "config.yml"), {
      disabledExtensions: ["extension-module:sf-pi-manager"],
    });

    expect(readOmpDisabledExtensionFiles(cwd)).toEqual(new Set());
    expect(isExtensionDisabledInOmpConfig("sf-pi-manager", cwd)).toBe(false);
  });

  it("lets a project list replace the global list, like OMP's array merge", () => {
    writeYaml(path.join(agentDir, "config.yml"), {
      disabledExtensions: ["extension-module:sf-slack"],
    });
    writeYaml(path.join(cwd, ".omp", "config.yml"), {
      disabledExtensions: ["extension-module:sf-fin"],
    });

    expect(resolveOmpConfigScope(cwd)).toBe("project");
    expect(readOmpDisabledExtensionFiles(cwd)).toEqual(new Set(["extensions/sf-fin/index.ts"]));
    expect(isExtensionDisabledInOmpConfig("sf-slack", cwd)).toBe(false);
  });

  it("writes only bundled entries, preserving other native settings and entries", () => {
    const configPath = path.join(agentDir, "config.yml");
    writeYaml(configPath, {
      setupVersion: 3,
      disabledExtensions: ["skill:noisy", "extension-module:sf-fin"],
    });

    const written = writeOmpDisabledExtensionFiles(
      cwd,
      "global",
      new Set(["extensions/sf-slack/index.ts", "extensions/sf-pi-manager/index.ts"]),
    );

    expect(written).toBe(configPath);
    expect(readYaml(configPath)).toEqual({
      setupVersion: 3,
      disabledExtensions: ["skill:noisy", "extension-module:sf-slack"],
    });
  });

  it("drops the global key when nothing is disabled but keeps an empty project list", () => {
    writeYaml(path.join(agentDir, "config.yml"), {
      disabledExtensions: ["extension-module:sf-slack"],
    });
    writeOmpDisabledExtensionFiles(cwd, "global", new Set());
    expect(readYaml(path.join(agentDir, "config.yml"))).toEqual({});

    const projectPath = writeOmpDisabledExtensionFiles(cwd, "project", new Set());
    expect(readYaml(projectPath)).toEqual({ disabledExtensions: [] });
  });

  it("refuses to overwrite a malformed config and fails open for the load gate", () => {
    const configPath = path.join(agentDir, "config.yml");
    writeYaml(configPath, { disabledExtensions: "extension-module:sf-slack" });

    expect(() => readOmpDisabledExtensionFiles(cwd)).toThrow(/string array/);
    expect(() =>
      writeOmpDisabledExtensionFiles(cwd, "global", new Set(["extensions/sf-slack/index.ts"])),
    ).toThrow(/string array/);
    expect(readYaml(configPath)).toEqual({ disabledExtensions: "extension-module:sf-slack" });
    expect(isExtensionDisabledInOmpConfig("sf-slack", cwd)).toBe(false);
    expect(existsSync(path.join(cwd, ".omp"))).toBe(false);
  });
});
