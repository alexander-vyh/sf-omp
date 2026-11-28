#!/usr/bin/env bun
/* SPDX-License-Identifier: Apache-2.0 */
/** Run after provision-salesforce-lsp.ts; preserves HOME/XDG and snapshots global OMP. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ROOT, proofOmpCommand, runtimeEnvironment } from "./omp-runtime.ts";

const runRoot = path.join(
  ROOT,
  ".runtime",
  "lsp-smoke",
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
);
const workspace = path.join(runRoot, "workspace");
const reportPath = path.join(runRoot, "report.json");
const globalRoot = path.join(homedir(), ".omp");
// Match the offline smoke's exclusions for active-session churn, not installed/config bytes.
const excludedDirectories: Record<string, true> = {
  sessions: true,
  "terminal-sessions": true,
  logs: true,
  cache: true,
  ".cache": true,
  blobs: true,
  run: true,
  tmp: true,
  "browser-profiles": true,
  wt: true,
  recovery: true,
  oauth: true,
};
async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string, relative = ""): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!relative && (error as NodeJS.ErrnoException).code === "ENOENT") {
        files["."] = "missing";
        return;
      }
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!Object.hasOwn(excludedDirectories, entry.name)) await visit(absolute, name);
      } else if (entry.isSymbolicLink()) files[name] = `symlink:${await readlink(absolute)}`;
      else if (entry.isFile() && !/\.db(?:[.-].*)?$|\.log(?:\..*)?$|\.token$/.test(entry.name)) {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(absolute)) hash.update(chunk);
        files[name] = hash.digest("hex");
      }
    }
  }
  await visit(globalRoot);
  return files;
}

await mkdir(runRoot, { recursive: true });
await cp(path.join(ROOT, "scripts", "fixtures", "omp-smoke"), workspace, { recursive: true });
const before = await snapshot();
await writeFile(
  path.join(runRoot, "global-omp-before.json"),
  `${JSON.stringify(before, null, 2)}\n`,
);
const env = runtimeEnvironment();
const preserved = Object.fromEntries(
  ["HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"].map((key) => [
    key,
    process.env[key],
  ]),
);
for (const [key, value] of Object.entries(preserved)) {
  if (env[key] !== value) throw new Error(`${key} changed by runtimeEnvironment.`);
}
// No prompt or org action is submitted; the dummy model only constructs native host context.
env.OPENAI_API_KEY = "offline-smoke-not-a-real-key";
env.SF_OMP_LSP_REPORT = reportPath;
env.SF_OMP_LSP_WORKSPACE = workspace;
env.SF_DISABLE_TELEMETRY = "true";
env.SFDX_DISABLE_TELEMETRY = "true";
const command = [
  ...proofOmpCommand(env),
  "--mode",
  "rpc",
  "--no-ui",
  "--no-session",
  "--no-title",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-context-files",
  "--trusted-extension",
  path.join(ROOT, "scripts", "omp-lsp-smoke-extension.ts"),
  "--provider",
  "openai",
  "--model",
  "gpt-4o-mini",
];
const child = Bun.spawn(command, {
  cwd: workspace,
  env,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
// Drain logs immediately so a verbose language server cannot block the host's pipes.
const stdout = new Response(child.stdout).text();
const stderr = new Response(child.stderr).text();
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, 100_000);
try {
  child.stdin.write(`${JSON.stringify({ id: "lsp-smoke-state-only", type: "get_state" })}\n`);
  await child.stdin.flush();
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  while (!exited && !timedOut && !(await Bun.file(reportPath).exists())) await Bun.sleep(100);
  child.stdin.end();
  const exitCode = await child.exited;
  await writeFile(path.join(runRoot, "omp.stdout.log"), await stdout);
  await writeFile(path.join(runRoot, "omp.stderr.log"), await stderr);
  let proof: Record<string, unknown>;
  try {
    proof = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    proof = { status: "failed", error: String(error) };
  }
  const after = await snapshot();
  await writeFile(
    path.join(runRoot, "global-omp-after.json"),
    `${JSON.stringify(after, null, 2)}\n`,
  );
  const changedPaths = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (name) => before[name] !== after[name],
  );
  const passed =
    proof.status === "pass" &&
    proof.sessionStarted === true &&
    proof.sessionShutdown === true &&
    !timedOut &&
    exitCode === 0 &&
    changedPaths.length === 0;
  const report = {
    ...proof,
    status: passed ? "pass" : "failed",
    launcher: { command, runRoot, exitCode, timedOut, homeXdgPreserved: true },
    globalOmpIntegrity: {
      status: changedPaths.length === 0 ? "pass" : "failed",
      filesBefore: Object.keys(before).length,
      filesAfter: Object.keys(after).length,
      changedPaths,
      excludedDirectories: Object.keys(excludedDirectories),
      excludedFiles: "*.db and sidecars, *.log and rotations, *.token",
    },
    limitations: [
      "Calls the real sf-apex diagnose.file implementation and sf-lsp diagnostic seam inside native OMP; model selection/tool dispatch are not exercised.",
      "No Salesforce org requests or model prompts are submitted.",
    ],
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    path.join(ROOT, ".runtime", "omp-lsp-smoke-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`OMP LSP smoke: ${passed ? "PASS" : "FAIL"}\nReport: ${reportPath}`);
  if (!passed) console.error(JSON.stringify(report, null, 2));
  process.exitCode = passed ? 0 : 1;
} finally {
  clearTimeout(timer);
}
