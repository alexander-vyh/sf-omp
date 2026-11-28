/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Behavior proofs for the OMP-host self-update: a real git fixture (bare
 * upstream + checkout + second writer) drives planning and the fast-forward;
 * only `npm`/`sf` are recorded instead of run.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyCheckoutUpdate, planCheckoutUpdate } from "../lib/auto-update-checkout.ts";
import { runNativeAutoUpdate } from "../lib/auto-update-runner.ts";

const PI_AGENT_ENV = "PI_CODING_AGENT_DIR";
let root = "";
let previousAgentDir: string | undefined;
let upstream = "";
let checkout = "";
let writer = "";
let recorded: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function commit(cwd: string, file: string, content: string): void {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `update ${file}`);
}

/** Real git; recorded npm/sf so no install or CLI update runs. */
const pi = {
  exec: vi.fn(async (command: string, args: string[], options: { cwd?: string } = {}) => {
    if (command !== "git") {
      recorded.push(`${command} ${args.join(" ")} @${options.cwd}`);
      return { stdout: "", stderr: "", code: 0, killed: false };
    }
    const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.status ?? 1,
      killed: false,
    };
  }),
} as unknown as ExtensionAPI;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "sf-omp-checkout-"));
  previousAgentDir = process.env[PI_AGENT_ENV];
  process.env[PI_AGENT_ENV] = path.join(root, "agent");
  recorded = [];
  const seed = path.join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  commit(seed, "README.md", "v1\n");
  upstream = path.join(root, "upstream.git");
  git(root, "clone", "-q", "--bare", seed, upstream);
  checkout = path.join(root, "checkout");
  writer = path.join(root, "writer");
  git(root, "clone", "-q", upstream, checkout);
  git(root, "clone", "-q", upstream, writer);
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env[PI_AGENT_ENV];
  else process.env[PI_AGENT_ENV] = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

describe("sf-omp checkout update planning", () => {
  it("reports a current checkout", async () => {
    const plan = await planCheckoutUpdate(pi, { root: checkout });
    expect(plan).toMatchObject({ state: "current", branch: "main", upstream: "origin/main" });
  });

  it("fast-forwards a clean, behind checkout and reinstalls locked dependencies", async () => {
    commit(writer, "README.md", "v2\n");
    git(writer, "push", "-q");

    const plan = await planCheckoutUpdate(pi, { root: checkout });
    expect(plan).toMatchObject({ state: "behind", ahead: 0, behind: 1 });

    const applied = await applyCheckoutUpdate(pi, plan, { root: checkout });
    expect(applied).toMatchObject({ result: "success", changed: true });
    expect(readFileSync(path.join(checkout, "README.md"), "utf8")).toBe("v2\n");
    expect(recorded).toEqual([`npm ci @${checkout}`]);
  });

  it("leaves a dirty checkout untouched", async () => {
    commit(writer, "README.md", "v2\n");
    git(writer, "push", "-q");
    writeFileSync(path.join(checkout, "README.md"), "local edit\n");

    const plan = await planCheckoutUpdate(pi, { root: checkout });
    expect(plan).toMatchObject({ state: "dirty", behind: 1 });
    const applied = await applyCheckoutUpdate(pi, plan, { root: checkout });

    expect(applied).toMatchObject({ result: "skipped", changed: false });
    expect(readFileSync(path.join(checkout, "README.md"), "utf8")).toBe("local edit\n");
    expect(recorded).toEqual([]);
  });

  it("classifies ahead and diverged checkouts without pulling", async () => {
    commit(checkout, "local.txt", "mine\n");
    expect(await planCheckoutUpdate(pi, { root: checkout })).toMatchObject({
      state: "ahead",
      ahead: 1,
    });

    commit(writer, "README.md", "v2\n");
    git(writer, "push", "-q");
    const plan = await planCheckoutUpdate(pi, { root: checkout });
    expect(plan).toMatchObject({ state: "diverged", ahead: 1, behind: 1 });
    expect((await applyCheckoutUpdate(pi, plan, { root: checkout })).result).toBe("skipped");
  });

  it("refuses detached, upstream-less, non-git, and unreachable checkouts", async () => {
    git(checkout, "checkout", "-q", "-b", "topic");
    expect((await planCheckoutUpdate(pi, { root: checkout })).state).toBe("no-upstream");

    git(checkout, "checkout", "-q", "--detach");
    expect((await planCheckoutUpdate(pi, { root: checkout })).state).toBe("detached");

    expect((await planCheckoutUpdate(pi, { root: os.tmpdir() })).state).toBe("not-git");

    git(checkout, "checkout", "-q", "main");
    rmSync(upstream, { recursive: true, force: true });
    expect((await planCheckoutUpdate(pi, { root: checkout })).state).toBe("fetch-failed");
  });
});

describe("Auto Update on the OMP host", () => {
  it("updates the checkout and the Salesforce CLI, never the OMP runtime", async () => {
    commit(writer, "README.md", "v2\n");
    git(writer, "push", "-q");
    const plans: unknown[] = [];
    const ctx = { cwd: checkout, hasUI: false, ui: { setStatus: vi.fn() } };

    const status = await runNativeAutoUpdate(pi, ctx as never, {
      checkoutRoot: checkout,
      env: {},
      onPlan: (plan) => plans.push(plan),
    });

    expect(plans).toEqual([
      expect.objectContaining({ checkout: expect.objectContaining({ state: "behind" }) }),
    ]);
    expect(status.targets?.map((target) => [target.target, target.result])).toEqual([
      ["pi-runtime", "skipped"],
      ["sf-omp-checkout", "success"],
      ["sf-cli", "success"],
    ]);
    expect(status.restartRecommended).toBe(true);
    expect(recorded.map((entry) => entry.split(" @")[0])).toEqual(["npm ci", "sf update stable"]);
    expect(recorded.join("\n")).not.toContain("pi update");
  });
});
