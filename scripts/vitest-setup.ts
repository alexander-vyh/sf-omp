/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Vitest setup shared by every test file.
 *
 * Fixture tests change HOME at runtime. Bun can cache the native home and
 * Windows reads USERPROFILE instead, so honor HOME for test-module imports.
 */
import type os from "node:os";
import { vi } from "vitest";

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
