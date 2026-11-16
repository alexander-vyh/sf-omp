/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sf-omp self-update: the package is a git checkout launched through
 * repository-local OMP, so "update" means fast-forwarding the checkout to its
 * upstream branch and reinstalling the locked dependencies (which also pin the
 * OMP runtime). Never `pi update`.
 *
 * Planning fetches the upstream and counts ahead/behind. Applying refuses
 * anything but a clean, attached branch that is strictly behind its upstream,
 * then runs `git pull --ff-only` and `npm ci`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnCommand } from "../../../lib/common/windows-spawn.ts";

/** Repository root of this checkout (extensions/sf-pi-manager/lib → root). */
export const CHECKOUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const GIT_TIMEOUT_MS = 2 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export type CheckoutUpdateState =
  | "current"
  | "behind"
  | "ahead"
  | "diverged"
  | "dirty"
  | "detached"
  | "no-upstream"
  | "not-git"
  | "fetch-failed";

export interface CheckoutUpdatePlan {
  state: CheckoutUpdateState;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  message: string;
}

export interface CheckoutExecOptions {
  root?: string;
  signal?: AbortSignal;
}

type Exec = Pick<ExtensionAPI, "exec">["exec"];

async function git(
  exec: Exec,
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const result = await exec("git", args, { cwd: root, timeout: GIT_TIMEOUT_MS, signal });
    return { ok: result.code === 0 && !result.killed, stdout: result.stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function plan(
  state: CheckoutUpdateState,
  message: string,
  extra: Partial<CheckoutUpdatePlan> = {},
): CheckoutUpdatePlan {
  return { state, message, ahead: 0, behind: 0, ...extra };
}

/** Fetch the checkout's upstream and classify how it can be updated. */
export async function planCheckoutUpdate(
  pi: Pick<ExtensionAPI, "exec">,
  options: CheckoutExecOptions = {},
): Promise<CheckoutUpdatePlan> {
  const root = options.root ?? CHECKOUT_ROOT;
  const exec: Exec = (...args) => pi.exec(...args);
  const inside = await git(exec, root, ["rev-parse", "--is-inside-work-tree"], options.signal);
  if (!inside.ok || inside.stdout !== "true") {
    return plan("not-git", "sf-omp is not running from a git checkout; update it manually.");
  }
  const branch = await git(exec, root, ["symbolic-ref", "--short", "-q", "HEAD"], options.signal);
  if (!branch.ok || !branch.stdout) {
    return plan("detached", "The checkout is on a detached HEAD; check out a branch to update.");
  }
  const upstream = await git(
    exec,
    root,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    options.signal,
  );
  if (!upstream.ok || !upstream.stdout) {
    return plan("no-upstream", `Branch ${branch.stdout} has no upstream to update from.`, {
      branch: branch.stdout,
    });
  }
  const context = { branch: branch.stdout, upstream: upstream.stdout };
  const remote = upstream.stdout.split("/")[0] ?? "origin";
  const fetched = await git(exec, root, ["fetch", "--quiet", remote], options.signal);
  if (!fetched.ok) {
    return plan(
      "fetch-failed",
      `Could not fetch ${remote}; the checkout was left unchanged.`,
      context,
    );
  }
  const counts = await git(
    exec,
    root,
    ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
    options.signal,
  );
  const [ahead = 0, behind = 0] = counts.stdout.split(/\s+/).map((value) => Number(value) || 0);
  const withCounts = { ...context, ahead, behind };
  if (!counts.ok) {
    return plan("fetch-failed", "Could not compare the checkout with its upstream.", context);
  }
  if (ahead > 0 && behind > 0) {
    return plan(
      "diverged",
      `${context.branch} has diverged from ${context.upstream} (${ahead} ahead, ${behind} behind); reconcile manually.`,
      withCounts,
    );
  }
  if (ahead > 0) {
    return plan(
      "ahead",
      `${context.branch} is ${ahead} commit(s) ahead of ${context.upstream}; nothing to pull.`,
      withCounts,
    );
  }
  if (behind === 0) {
    return plan("current", `${context.branch} is up to date with ${context.upstream}.`, withCounts);
  }
  const status = await git(
    exec,
    root,
    ["status", "--porcelain", "--untracked-files=no"],
    options.signal,
  );
  if (!status.ok || status.stdout) {
    return plan(
      "dirty",
      `${context.branch} is ${behind} commit(s) behind ${context.upstream}, but tracked files have local changes; commit or stash them first.`,
      withCounts,
    );
  }
  return plan(
    "behind",
    `${context.branch} is ${behind} commit(s) behind ${context.upstream}.`,
    withCounts,
  );
}

export interface CheckoutApplyResult {
  result: "success" | "failed" | "skipped";
  message: string;
  /** True once git moved HEAD, so a restart is needed even if npm ci failed. */
  changed: boolean;
}

/** Fast-forward a `behind` checkout and reinstall its locked dependencies. */
export async function applyCheckoutUpdate(
  pi: Pick<ExtensionAPI, "exec">,
  checkoutPlan: CheckoutUpdatePlan,
  options: CheckoutExecOptions = {},
): Promise<CheckoutApplyResult> {
  if (checkoutPlan.state !== "behind") {
    return { result: "skipped", message: checkoutPlan.message, changed: false };
  }
  const root = options.root ?? CHECKOUT_ROOT;
  const exec: Exec = (...args) => pi.exec(...args);
  const pulled = await git(exec, root, ["pull", "--ff-only", "--quiet"], options.signal);
  if (options.signal?.aborted) {
    return { result: "skipped", message: "Cancelled before the checkout changed.", changed: false };
  }
  if (!pulled.ok) {
    return {
      result: "failed",
      message: "git pull --ff-only failed; the checkout was left unchanged.",
      changed: false,
    };
  }
  try {
    const [npmFile, npmArgs] = spawnCommand("npm", ["ci"]);
    const installed = await pi.exec(npmFile, npmArgs, {
      cwd: root,
      timeout: INSTALL_TIMEOUT_MS,
      signal: options.signal,
    });
    if (installed.code === 0 && !installed.killed) {
      return {
        result: "success",
        message: `Fast-forwarded ${checkoutPlan.behind} commit(s) from ${checkoutPlan.upstream} and reinstalled locked dependencies with npm ci.`,
        changed: true,
      };
    }
  } catch {
    // Reported below; the pulled source still requires a restart.
  }
  return {
    result: "failed",
    message: `Fast-forwarded ${checkoutPlan.behind} commit(s), but npm ci failed; run npm ci in the checkout before restarting.`,
    changed: true,
  };
}
