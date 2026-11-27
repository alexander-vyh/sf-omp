/* SPDX-License-Identifier: Apache-2.0 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const checkout = fileURLToPath(new URL("../..", import.meta.url));
const nodeDirectory = path.dirname(
  execFileSync("/usr/bin/which", ["node"], { encoding: "utf8" }).trim(),
);

describe("native OMP launcher", () => {
  let root: string;
  let checkoutFixture: string;
  let workspace: string;
  let native: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "sf-omp-launcher-")));
    checkoutFixture = path.join(root, "sf-omp");
    workspace = path.join(root, "consumer/nested");
    native = path.join(root, "native/omp");
    const shared = path.join(checkoutFixture, "tools/bin");
    const consumer = path.join(root, "consumer/tools/bin");
    const modules = path.join(checkoutFixture, "node_modules");
    const npmBin = path.join(modules, ".bin");
    for (const dir of [
      shared,
      consumer,
      workspace,
      npmBin,
      path.join(modules, "@oh-my-pi"),
      path.join(checkoutFixture, "scripts"),
      path.dirname(native),
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    for (const file of [
      "tools/bin/omp",
      "scripts/native-omp.ts",
      "scripts/omp.ts",
      "scripts/omp-auth.ts",
      "scripts/omp-auth-broker.ts",
      "scripts/omp-runtime.ts",
      "package.json",
    ]) {
      copyFileSync(path.join(checkout, file), path.join(checkoutFixture, file));
    }
    chmodSync(path.join(shared, "omp"), 0o755);
    symlinkSync("../../../sf-omp/tools/bin/omp", path.join(consumer, "omp"));
    for (const dep of [
      "bun",
      "@oh-my-pi/pi-ai",
      "@oh-my-pi/pi-utils",
      "@oh-my-pi/pi-coding-agent",
    ]) {
      symlinkSync(path.join(checkout, "node_modules", dep), path.join(modules, dep), "dir");
    }
    symlinkSync("../@oh-my-pi/pi-coding-agent/dist/cli.js", path.join(npmBin, "omp"));
    writeFileSync(
      native,
      `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const versionFile = __dirname + "/version";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "update") writeFileSync(versionFile, "99.2.0");
const version = readFileSync(versionFile, "utf8");
const config = args.indexOf("--config");
console.log(JSON.stringify({
  args, version, cwd: process.cwd(),
  ompOnPath: execFileSync("/usr/bin/which", ["omp"], { encoding: "utf8" }).trim(),
  agentDir: process.env.PI_CODING_AGENT_DIR ?? null,
  authOverlay: config === -1 ? null : JSON.parse(readFileSync(args[config + 1], "utf8")),
}));
if (args.includes("--force")) process.exitCode = 42;
`,
      { mode: 0o755 },
    );
    writeFileSync(path.join(path.dirname(native), "version"), "99.1.0");
    env = {
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: [
        consumer,
        shared,
        npmBin,
        path.dirname(native),
        nodeDirectory,
        "/usr/bin",
        "/bin",
      ].join(path.delimiter),
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function launch(cwd: string, launcher: string, ...args: string[]) {
    return spawnSync(launcher, args, { cwd, env, encoding: "utf8", timeout: 5000 });
  }

  function git(...args: string[]) {
    return execFileSync("git", ["-C", checkoutFixture, ...args], { env, encoding: "utf8" });
  }

  it.each(["--check", "--canary", "--stable", "--plugins", "--help", "--force"])(
    "forwards native update %s with the original cwd and exit status",
    (flag) => {
      const result = launch(workspace, "omp", "update", flag);
      expect(result.status, result.stderr).toBe(flag === "--force" ? 42 : 0);
      expect(JSON.parse(result.stdout)).toEqual({
        args: ["update", flag],
        cwd: workspace,
        ompOnPath: native,
        agentDir: null,
        authOverlay: null,
        version: "99.1.0",
      });
      expect(existsSync(path.join(checkoutFixture, ".runtime"))).toBe(false);
    },
  );

  it("does not fall back to the npm proof binary when native OMP is missing", () => {
    env.PATH = env
      .PATH!.split(path.delimiter)
      .filter((directory) => directory !== path.dirname(native))
      .join(path.delimiter);
    const result = launch(workspace, "omp", "--version");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Native omp is not on PATH");
    expect(existsSync(path.join(checkoutFixture, ".runtime"))).toBe(false);
  });

  it("uses the upgraded native binary for both projects without touching local edits", () => {
    const changed = path.join(checkoutFixture, "tracked");
    const untracked = path.join(checkoutFixture, "local");
    git("init", "-q", "-b", "main");
    writeFileSync(changed, "original\n");
    git("add", "tracked");
    git(
      "-c",
      "user.name=Launcher Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "Initial",
    );
    writeFileSync(changed, "edited\n");
    writeFileSync(untracked, "untracked\n");
    const head = git("rev-parse", "HEAD");
    execFileSync(
      path.join(checkout, "node_modules/bun/bin/bun.exe"),
      [
        "-e",
        `import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
const db = getAgentDbPath();
mkdirSync(dirname(db), { recursive: true, mode: 0o700 });
const store = await SqliteAuthCredentialStore.open(db);
store.close();`,
      ],
      { cwd: checkoutFixture, env },
    );
    const status = git("status", "--porcelain");
    const shared = path.join(checkoutFixture, "tools/bin/omp");

    const update = launch(checkoutFixture, shared, "update");
    expect(update.status, update.stderr).toBe(0);
    expect(JSON.parse(update.stdout).version).toBe("99.2.0");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("status", "--porcelain")).toBe(status);
    expect(readFileSync(changed, "utf8")).toBe("edited\n");
    expect(readFileSync(untracked, "utf8")).toBe("untracked\n");

    for (const [cwd, launcher] of [
      [checkoutFixture, shared],
      [workspace, "omp"],
    ] as const) {
      const result = launch(cwd, launcher, "--mode", "rpc");
      expect(result.status, result.stderr).toBe(0);
      const invocation = JSON.parse(result.stdout);
      expect(invocation).toMatchObject({
        cwd,
        ompOnPath: native,
        version: "99.2.0",
        agentDir: path.join(checkoutFixture, ".runtime/omp/agent"),
        authOverlay: { auth: { accountPolicies: [] } },
      });
      expect(invocation.args).toEqual([
        "--no-extensions",
        "-e",
        checkoutFixture,
        "--config",
        expect.any(String),
        "--mode",
        "rpc",
      ]);
      expect(existsSync(invocation.args[4])).toBe(false);
    }
  });
});
