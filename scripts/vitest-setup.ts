/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Vitest setup shared by every test file.
 *
 * Tests fake the home folder by assigning `process.env.HOME`. On Windows,
 * `os.homedir()` reads `USERPROFILE` instead, so those tests would read and
 * write the real profile. In tests only, make `os.homedir()` honor HOME on
 * Windows the same way it already does on macOS and Linux. No effect off
 * Windows, and production code is unchanged.
 */
import module from "node:module";
import os from "node:os";

if (process.platform === "win32") {
  const original = os.homedir;
  os.homedir = () => process.env.HOME || original();
  // Keep `import { homedir } from "node:os"` bindings in sync with the patch.
  module.syncBuiltinESMExports();
}

// Tests launched from inside an sf-omp session inherit the launcher's agent
// directory and auth-broker variables. Agent-dir-relative test state would then
// land in the real `.runtime/omp/agent` instead of each test's fake home.
for (const name of Object.keys(process.env)) {
  if (/^(?:PI_|OMP_AUTH_BROKER_)/.test(name) || name === "OMPCODE") delete process.env[name];
}
