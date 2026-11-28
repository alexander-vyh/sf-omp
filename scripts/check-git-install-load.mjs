#!/usr/bin/env bun
/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Git-install load smoke test.
 *
 * Copy the git package into a temporary directory, run
 * `npm install --omit=dev --legacy-peer-deps`, then load every extension
 * through OMP's published extension loader, which aliases its host modules.
 * A runtime import that only resolves in this repo's dev install fails here
 * the same way it fails for users.
 *
 * Uses the pinned OMP dev package as the host, never the git package's dev deps.
 * Network: npm registry (production dependencies only).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const work = mkdtempSync(path.join(tmpdir(), "sf-pi-git-install-"));
const keep = process.argv.includes("--keep");
try {
  // Files a commit of this tree would contain: tracked plus untracked files
  // that are not gitignored (so a local run before `git add` matches CI).
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repoRoot },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    const from = path.join(repoRoot, file);
    if (existsSync(from)) cpSync(from, path.join(work, file), { recursive: false });
  }
  execFileSync(
    "npm",
    ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund", "--ignore-scripts"],
    { cwd: work, stdio: ["ignore", "ignore", "inherit"] },
  );
  for (const devOnly of ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-tui", "typescript", "vitest"]) {
    if (existsSync(path.join(work, "node_modules", devOnly))) {
      throw new Error(`${devOnly} is present after --omit=dev; the git fixture includes dev deps.`);
    }
  }

  const { loadExtensions } =
    await import("@oh-my-pi/pi-coding-agent/extensibility/extensions/loader");
  const entries = readdirSync(path.join(work, "extensions"))
    .map((name) => path.join(work, "extensions", name, "index.ts"))
    .filter((file) => existsSync(file))
    .sort();
  const result = await loadExtensions(entries, work);
  const errors = (result.errors ?? []).map((error) => ({
    extension: path.relative(work, error.path ?? ""),
    error: String(error.error ?? error.message ?? error).split("\n")[0],
  }));
  if (errors.length > 0) {
    console.error(
      `❌ ${errors.length} of ${entries.length} extensions failed to load from a git-style install:`,
    );
    for (const e of errors) console.error(`  - ${e.extension}: ${e.error}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ git-install load check passed (${entries.length} extensions)`);
  }
} finally {
  if (!keep) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
