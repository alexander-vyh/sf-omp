/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Targeted tests for registry-driven extension health.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverExtensionHealth } from "../lib/extension-health.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// Global OMP config is only read from inside this checkout's .runtime directory,
// so each test gets an isolated agent dir there.
function makeAgentDir(): string {
  const root = fileURLToPath(new URL("../../../.runtime/skill-tests/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "sf-welcome-agent-"));
  tempDirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function writeDisabledExtensions(configPath: string, ids: string[]): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  const entries = ids.map((id) => `  - extension-module:${id}\n`).join("");
  writeFileSync(configPath, `disabledExtensions:\n${entries}`, "utf8");
}

afterEach(() => {
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("discoverExtensionHealth", () => {
  it("includes registry entries with display-name overrides", () => {
    makeAgentDir();

    const health = discoverExtensionHealth(makeTempDir("sf-welcome-project-"));
    expect(health.some((item) => item.name === "LLM Gateway")).toBe(true);
    expect(health.some((item) => item.name === "Pi Manager" && item.status === "locked")).toBe(
      true,
    );
  });

  it("reads global OMP disabledExtensions when the project config defines none", () => {
    const agentDir = makeAgentDir();
    const projectDir = makeTempDir("sf-welcome-project-");
    writeDisabledExtensions(path.join(agentDir, "config.yml"), ["sf-welcome"]);

    const health = discoverExtensionHealth(projectDir);

    expect(health.find((item) => item.name === "Welcome")?.status).toBe("disabled");
  });

  it("prefers project OMP disabledExtensions over global when the project defines them", () => {
    const agentDir = makeAgentDir();
    const projectDir = makeTempDir("sf-welcome-project-");
    writeDisabledExtensions(path.join(agentDir, "config.yml"), ["sf-welcome"]);
    writeDisabledExtensions(path.join(projectDir, ".omp", "config.yml"), ["sf-ohana-spinner"]);

    const health = discoverExtensionHealth(projectDir);
    const spinner = health.find((item) => item.name === "Ohana Spinner");
    const welcome = health.find((item) => item.name === "Welcome");

    expect(spinner?.status).toBe("disabled");
    expect(welcome?.status).toBe("active");
  });
});
