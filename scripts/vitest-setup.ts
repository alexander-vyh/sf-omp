/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Vitest setup shared by every test file.
 *
 * Fixture tests change HOME at runtime. Bun can cache the native home and
 * Windows reads USERPROFILE instead, so honor HOME for test-module imports.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os & { default: typeof os }>();
  const homedir = () => process.env.HOME || actual.homedir();
  return { ...actual, homedir, default: { ...actual.default, homedir } };
});

// Tests launched from inside an sf-omp session inherit the launcher's agent
// directory and auth-broker variables. Agent-dir-relative test state would then
// land in the real `.runtime/omp/agent` instead of each test's fake home.
for (const name of Object.keys(process.env)) {
  if (/^(?:PI_|OMP_AUTH_BROKER_)/.test(name) || name === "OMPCODE") delete process.env[name];
}

// Without PI_CODING_AGENT_DIR, native OMP config falls back to the checkout's
// own `.runtime/omp/agent`, so a developer's disabled extensions or skill roots
// would leak into results. Like the sf-omp launcher, point it at an agent dir:
// an empty one per test (and one for module-load code), inside `.runtime`
// because native global config refuses to live anywhere else.
const testAgentRoot = fileURLToPath(new URL("../.runtime/vitest/", import.meta.url));
mkdirSync(testAgentRoot, { recursive: true });
const fileAgentRoot = mkdtempSync(path.join(testAgentRoot, "file-"));
process.env.PI_CODING_AGENT_DIR = path.join(fileAgentRoot, "agent");
let testAgentDir = "";

beforeEach(() => {
  testAgentDir = mkdtempSync(path.join(fileAgentRoot, "test-"));
  process.env.PI_CODING_AGENT_DIR = path.join(testAgentDir, "agent");
});

afterEach(() => {
  process.env.PI_CODING_AGENT_DIR = path.join(fileAgentRoot, "agent");
  rmSync(testAgentDir, { recursive: true, force: true });
});

afterAll(() => rmSync(fileAgentRoot, { recursive: true, force: true }));
