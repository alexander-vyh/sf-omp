#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
/** Generate sanitized Instruction Surface JSON/Markdown through the pinned OMP runtime. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  OMP_ISOLATION_ARGS,
  OMP_OFFLINE_MODEL_ARGS,
  ompTestHost,
} from "../lib/common/tests/omp-host.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repoRoot, "scripts", "fixtures", "instruction-surface-probe.ts");
const outputDir = resolveOutput(process.argv.slice(2));
mkdirSync(outputDir, { recursive: true });

// Hermetic pinned OMP host, explicit-only like the sf-omp launcher: this
// checkout's extensions, the probe, and an in-process model that never calls out.
const hostRoot = mkdtempSync(path.join(tmpdir(), "sf-omp-instruction-surface-"));
let result;
try {
  const host = ompTestHost(hostRoot, {
    SF_PI_INSTRUCTION_SURFACE_PACKAGE_ROOT: repoRoot,
    SF_PI_INSTRUCTION_SURFACE_OUTPUT: outputDir,
    SF_PI_INSTRUCTION_SURFACE_INCLUDE_BUNDLED_CONTEXT: "1",
  });
  const [executable, ...ompCli] = host.command;
  result = spawnSync(
    executable,
    [
      ...ompCli,
      ...OMP_ISOLATION_ARGS,
      ...OMP_OFFLINE_MODEL_ARGS,
      "-e",
      repoRoot,
      "-e",
      fixture,
      "--print",
      "/sf-pi-instruction-surface-probe",
    ],
    { cwd: repoRoot, env: host.env, encoding: "utf8", timeout: 60_000 },
  );
} finally {
  rmSync(hostRoot, { recursive: true, force: true });
}

if (result.status !== 0) {
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

console.log(`Instruction Surface report written to:`);
console.log(`- ${path.join(outputDir, "report.json")}`);
console.log(`- ${path.join(outputDir, "report.md")}`);

function resolveOutput(argv) {
  const index = argv.indexOf("--output");
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value) throw new Error("--output requires a directory.");
    return path.resolve(process.cwd(), value);
  }
  return path.join(repoRoot, ".pi", "state", "sf-brain", "instruction-surface");
}
