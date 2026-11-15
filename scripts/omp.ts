/* SPDX-License-Identifier: Apache-2.0 */
import { spawn } from "node:child_process";
import { localOmpCommand, ROOT, runtimeEnvironment } from "./omp-runtime.ts";

try {
  const [executable, ...runtimeArgs] = localOmpCommand();
  const child = spawn(
    executable,
    [...runtimeArgs, "--no-extensions", "-e", ROOT, ...process.argv.slice(2)],
    {
      cwd: process.cwd(),
      env: runtimeEnvironment(),
      stdio: "inherit",
    },
  );
  child.on("error", (error) => {
    console.error(`sf-omp: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
} catch (error) {
  console.error(`sf-omp: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
