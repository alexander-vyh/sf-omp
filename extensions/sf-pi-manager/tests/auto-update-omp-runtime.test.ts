/* SPDX-License-Identifier: Apache-2.0 */
/** Native OMP lifecycle proof for settled-turn (terminal agent_end) automatic updates. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  OMP_ISOLATION_ARGS,
  OMP_OFFLINE_MODEL_ARGS,
  REPO_ROOT,
  ompTestHost,
} from "../../../lib/common/tests/omp-host.ts";
import { writeFakeNodeCli } from "../../../lib/common/test-fixtures.ts";

const tempDirs: string[] = [];

interface AutoUpdateEntry {
  customType?: string;
  data?: { title?: string };
}

interface RpcFrame {
  type?: string;
  method?: string;
  statusKey?: string;
  statusText?: string;
  command?: string;
  data?: { entries?: AutoUpdateEntry[] };
}

/** A fake CLI that logs `<name> <args>` and prints the reply registered for those args. */
function writeLoggingCli(dir: string, name: string, replies: Record<string, string> = {}): void {
  writeFakeNodeCli(
    path.join(dir, name),
    [
      'const { appendFileSync } = require("node:fs");',
      'const args = process.argv.slice(2).join(" ");',
      `appendFileSync(process.env.SF_PI_M6_COMMAND_LOG, ${JSON.stringify(name)} + " " + args + "\\n");`,
      `const reply = ${JSON.stringify(replies)}[args];`,
      'if (reply !== undefined) process.stdout.write(reply + "\\n");',
    ].join("\n"),
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Settled-turn Update Coordinator through native OMP", () => {
  it("runs after a terminal agent_end with suppression env set and never invokes self-update", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sf-omp-auto-update-"));
    tempDirs.push(root);
    const fakeBin = path.join(root, "bin");
    const commandLog = path.join(root, "commands.log");
    mkdirSync(fakeBin, { recursive: true });
    const host = ompTestHost(root, {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      PI_SKIP_VERSION_CHECK: "1",
      PI_UPDATER_SUPPRESSED_NATIVE_VERSION_CHECK: "1",
      SF_PI_M6_COMMAND_LOG: commandLog,
    });
    // Consent lives in sf-omp's settings.json; any config.yml keeps OMP from
    // migrating that file away as legacy Pi settings at startup.
    writeFileSync(
      path.join(host.agentDir, "settings.json"),
      JSON.stringify({ sfPi: { autoUpdate: true } }),
    );
    writeFileSync(
      path.join(host.agentDir, "config.yml"),
      "modelRoles:\n  default: sf-omp-offline/probe\n",
    );

    // On OMP the update target is the sf-omp checkout itself. The fake git
    // reports a clean branch two commits behind upstream, so the fast-forward
    // path runs without touching the real checkout.
    writeLoggingCli(fakeBin, "git", {
      "rev-parse --is-inside-work-tree": "true",
      "symbolic-ref --short -q HEAD": "main",
      "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
      "rev-list --left-right --count HEAD...@{u}": "0\t2",
    });
    // `omp` and `pi` are self-update tripwires.
    for (const name of ["npm", "sf", "omp", "pi"]) writeLoggingCli(fakeBin, name);

    const [executable, ...cli] = host.command;
    const child = spawn(
      executable,
      [
        ...cli,
        ...OMP_ISOLATION_ARGS,
        "-e",
        path.join(REPO_ROOT, "extensions/sf-pi-manager/index.ts"),
        ...OMP_OFFLINE_MODEL_ARGS,
        "--mode",
        "rpc",
      ],
      { cwd: root, env: host.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let unread = "";
    let entries: AutoUpdateEntry[] = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      unread += chunk;
      for (let newline = unread.indexOf("\n"); newline >= 0; newline = unread.indexOf("\n")) {
        const frame = JSON.parse(unread.slice(0, newline)) as RpcFrame;
        unread = unread.slice(newline + 1);
        // The runner clears its status as it finishes. OMP's RPC stream does not
        // publish appended entries, so read the session's entries then.
        if (
          frame.method === "setStatus" &&
          frame.statusKey === "sf-pi-auto-update" &&
          frame.statusText === undefined
        ) {
          child.stdin.write(`${JSON.stringify({ type: "get_entries" })}\n`);
        } else if (frame.type === "response" && frame.command === "get_entries") {
          entries = (frame.data?.entries ?? []).filter(
            (entry) => entry.customType === "sf-pi-auto-update",
          );
          if (entries.some((entry) => entry.data?.title === "Auto Update complete")) {
            child.stdin.end();
          }
        }
      }
    });

    // tsconfig's ES2022 lib has no Promise.withResolvers.
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      // A real child process: kill it and surface its output if it never exits.
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`native OMP Auto Update proof timed out\n${stderr}\n${stdout}`));
      }, 30_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.stdin.write(`${JSON.stringify({ id: "settle", type: "prompt", message: "settle" })}\n`);
    });

    expect(exitCode, stderr).toBe(0);
    expect(existsSync(commandLog), JSON.stringify({ stdout, stderr }, null, 2)).toBe(true);
    const commands = readFileSync(commandLog, "utf8").trim().split("\n");
    expect(commands).toEqual([
      "git rev-parse --is-inside-work-tree",
      "git symbolic-ref --short -q HEAD",
      "git rev-parse --abbrev-ref --symbolic-full-name @{u}",
      "git fetch --quiet origin",
      "git rev-list --left-right --count HEAD...@{u}",
      "git status --porcelain --untracked-files=no",
      "git pull --ff-only --quiet",
      "npm ci",
      "sf update stable",
    ]);
    // Auto Update never updates the OMP runtime: no `omp update` or `pi update`.
    expect(commands.filter((command) => /^(?:omp|pi) /.test(command))).toEqual([]);

    expect(entries.map((entry) => entry.data?.title)).toEqual([
      "Auto Update planned",
      "Auto Update complete",
    ]);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(REPO_ROOT);
  }, 35_000);
});
