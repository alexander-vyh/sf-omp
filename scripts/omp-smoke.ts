#!/usr/bin/env bun
/* SPDX-License-Identifier: Apache-2.0 */
/** Offline consumer smoke: real local OMP, no prompts, no inherited org or model auth. */
import { cp, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { createReadStream, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { ROOT, localOmpCommand, runtimeEnvironment } from "./omp-runtime.ts";

const runtimeRoot = path.join(ROOT, ".runtime");
const runRoot = path.join(
  runtimeRoot,
  "smoke",
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
);
const workspace = path.join(runRoot, "workspace");
const childReportPath = path.join(runRoot, "report.json");
const latestReportPath = path.join(runtimeRoot, "omp-smoke-report.json");
const stdoutPath = path.join(runRoot, "omp.stdout.log");
const stderrPath = path.join(runRoot, "omp.stderr.log");
const globalOmpRoot = path.join(homedir(), ".omp");
// Only active-session/runtime churn is excluded; configuration and installed bytes remain covered.
const excludedDirectories = new Set([
  "sessions",
  "terminal-sessions",
  "logs",
  "cache",
  ".cache",
  "blobs",
  "run",
  "tmp",
  "browser-profiles",
  "wt",
  "recovery",
  "oauth",
]);
async function globalSnapshot(): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function visit(directory: string, relative: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (relative === "" && object(error).code === "ENOENT") {
        snapshot["."] = "missing";
        return;
      }
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) await visit(absolute, name);
      } else if (entry.isSymbolicLink()) {
        snapshot[name] = `symlink:${await readlink(absolute)}`;
      } else if (entry.isFile() && !/\.db(?:[.-].*)?$|\.log(?:\..*)?$|\.token$/.test(entry.name)) {
        const hash = createHash("sha256");
        for await (const data of createReadStream(absolute)) {
          const chunk: unknown = data;
          if (typeof chunk === "string" || Buffer.isBuffer(chunk)) hash.update(chunk);
          else throw new Error(`Unexpected snapshot stream chunk: ${absolute}`);
        }
        snapshot[name] = hash.digest("hex");
      }
    }
  }
  await visit(globalOmpRoot, "");
  return snapshot;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

await mkdir(runRoot, { recursive: true });
try {
  await cp(path.join(ROOT, "scripts", "fixtures", "omp-smoke"), workspace, { recursive: true });
  const startupSkill = path.join(workspace, ".omp", "skills", "sf-omp-startup-smoke", "SKILL.md");
  await mkdir(path.dirname(startupSkill), { recursive: true });
  await writeFile(
    startupSkill,
    "---\nname: sf-omp-startup-smoke\ndescription: Offline native skill-command discovery.\n---\nUse only for the local startup smoke.\n",
  );
  // An explicit stateRoot selects the helper's hermetic HOME/XDG/OMP mode.
  const stateRoot = path.join(runRoot, "state");
  const env = runtimeEnvironment(stateRoot);
  for (const key of Object.keys(env)) {
    if (
      /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|SF_TARGET_ORG|SFDX_DEFAULTUSERNAME)/i.test(
        key,
      )
    )
      delete env[key];
  }
  env.OPENAI_API_KEY = "offline-smoke-not-a-real-key";
  env.SF_OMP_SMOKE_REPORT = childReportPath;
  env.SF_OMP_SMOKE_WORKSPACE = workspace;
  env.SF_DISABLE_TELEMETRY = "true";
  env.SFDX_DISABLE_TELEMETRY = "true";
  env.CI = "true";
  // RPC receives only get_state, never prompt/steer; EOF also guarantees teardown.
  const command = [
    ...localOmpCommand(),
    "--mode",
    "rpc",
    "--no-ui",
    "--no-session",
    "--no-title",
    "--no-extensions",
    "--skills",
    "sf-omp-startup-smoke",
    "--no-rules",
    "--no-context-files",
    "--trusted-extension",
    path.join(ROOT, "scripts", "omp-smoke-extension.ts"),
    "--provider",
    "openai",
    "--model",
    "gpt-4o-mini",
  ];
  env.SF_OMP_SMOKE_CLI = command[1];
  env.SF_OMP_SMOKE_STATE_ROOT = stateRoot;
  env.SF_OMP_SMOKE_CONFIG_ROOT = path.resolve(env.HOME ?? "", env.PI_CONFIG_DIR ?? ".omp");
  const before = await globalSnapshot();
  await writeFile(
    path.join(runRoot, "global-omp-before.json"),
    `${JSON.stringify(before, null, 2)}\n`,
  );
  const child = Bun.spawn(command, {
    cwd: workspace,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${JSON.stringify({ id: "smoke-context-only", type: "get_state" })}\n`);
  child.stdin.end();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 120_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  await Promise.all([writeFile(stdoutPath, stdout), writeFile(stderrPath, stderr)]);
  let childReport: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(childReportPath, "utf8"));
    childReport = object(parsed);
  } catch (error) {
    childReport = {
      schemaVersion: 1,
      status: "failed",
      sessionStarted: false,
      reason: "OMP did not produce the smoke extension report; inspect the child startup logs.",
      reportError: error instanceof Error ? error.message : String(error),
    };
  }
  const after = await globalSnapshot();
  await writeFile(
    path.join(runRoot, "global-omp-after.json"),
    `${JSON.stringify(after, null, 2)}\n`,
  );
  const changedGlobalPaths = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (name) => before[name] !== after[name],
  );
  const passed =
    changedGlobalPaths.length === 0 &&
    !timedOut &&
    exitCode === 0 &&
    childReport.status === "pass" &&
    childReport.sessionStarted === true &&
    childReport.sessionShutdown === true;
  const report = {
    ...childReport,
    status: passed ? "pass" : "failed",
    globalOmpIntegrity: {
      status: changedGlobalPaths.length === 0 ? "pass" : "failed",
      root: globalOmpRoot,
      filesBefore: Object.keys(before).length,
      filesAfter: Object.keys(after).length,
      changedPaths: changedGlobalPaths,
      excludedDirectories: [...excludedDirectories],
      excludedFiles:
        "*.db and DB sidecars/locks, *.log and rotated logs, *.token (active assistant runtime state)",
      snapshotFiles: [
        path.join(runRoot, "global-omp-before.json"),
        path.join(runRoot, "global-omp-after.json"),
      ],
    },
    launcher: { command, runRoot, exitCode, timedOut, stdoutPath, stderrPath, childReportPath },
  };
  await writeFile(latestReportPath, `${JSON.stringify(report, null, 2)}\n`);
  const checks = Array.isArray(childReport.checks) ? childReport.checks.map(object) : [];
  const extensions = Array.isArray(childReport.selectedExtensions)
    ? childReport.selectedExtensions.map(object)
    : [];
  console.log(`OMP offline smoke: ${passed ? "PASS" : "FAIL"}`);
  console.log(
    `Extensions loaded: ${extensions.filter((entry) => entry.loaded === true).length}/10`,
  );
  console.log(
    `Global OMP configuration/install unchanged: ${changedGlobalPaths.length === 0 ? "PASS" : `FAIL (${changedGlobalPaths.join(", ")})`}`,
  );
  for (const check of checks) {
    console.log(
      `[${String(check.status)}] ${String(check.name)}${check.reason ? ` — ${String(check.reason)}` : ""}`,
    );
  }
  console.log(`Report: ${latestReportPath}`);
  console.log(`Child logs: ${runRoot}`);
  if (!passed && checks.length === 0)
    console.error(stderr.slice(-6000) || String(childReport.reason ?? "OMP startup failed."));
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  await writeFile(
    latestReportPath,
    `${JSON.stringify({ schemaVersion: 1, status: "failed", sessionStarted: false, reason, launcher: { runRoot, childReportPath, stdoutPath, stderrPath } }, null, 2)}\n`,
  );
  console.error(`OMP offline smoke: FAIL — ${reason}\nReport: ${latestReportPath}`);
  process.exitCode = 1;
}
