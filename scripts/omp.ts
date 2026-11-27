/* SPDX-License-Identifier: Apache-2.0 */
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { findNativeOmp } from "./native-omp.ts";
import { connectGlobalAuth } from "./omp-auth.ts";
import { ROOT, runtimeEnvironment } from "./omp-runtime.ts";

let child: ChildProcess | undefined;
let auth: Awaited<ReturnType<typeof connectGlobalAuth>> | undefined;
const interrupt = () => {
  if (child) child.kill("SIGINT");
  else process.exit(130);
};
const terminate = () => {
  if (child) {
    child.kill("SIGTERM");
    void auth?.close();
  } else {
    process.exit(143);
  }
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
process.on("SIGHUP", terminate);

try {
  const native = findNativeOmp(ROOT);
  if (!native)
    throw new Error("Native omp is not on PATH. Install OMP from https://omp.sh/ first.");
  const args = process.argv.slice(2);
  let childArgs = args;
  let environment: NodeJS.ProcessEnv;
  if (args[0] === "update" || (args.length === 1 && args[0] === "--version")) {
    environment = { ...process.env, PATH: native.searchPath };
  } else {
    const runtime = runtimeEnvironment();
    auth = await connectGlobalAuth();
    childArgs = ["--no-extensions", "-e", ROOT, ...auth.args, ...args];
    environment = {
      ...runtime,
      ...auth.environment,
      PATH: `${path.dirname(native.executable)}${path.delimiter}${runtime.PATH ?? ""}`,
    };
  }
  child = spawn(native.executable, childArgs, {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
  });
  const finished = Promise.withResolvers<void>();
  child.once("error", finished.reject);
  child.once("close", (code, signal) => {
    process.exitCode = code !== null && code >= 0 ? code : signal || code !== null ? 1 : 0;
    finished.resolve();
  });
  await finished.promise;
} catch (error) {
  console.error(`sf-omp: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await auth?.close();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
  process.removeListener("SIGHUP", terminate);
}
