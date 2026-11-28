/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Fake `pi.exec` for Auto Update tests: git answers as a clean `main` checkout
 * two commits behind `origin/main`, and every other command succeeds.
 */
import { vi } from "vitest";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

const BEHIND_GIT_REPLIES: Record<string, string> = {
  "rev-parse --is-inside-work-tree": "true",
  "symbolic-ref --short -q HEAD": "main",
  "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
  "rev-list --left-right --count HEAD...@{u}": "0\t2",
};

/** Commands of a full checkout fast-forward, in order. */
export const CHECKOUT_UPDATE = [
  "git rev-parse --is-inside-work-tree",
  "git symbolic-ref --short -q HEAD",
  "git rev-parse --abbrev-ref --symbolic-full-name @{u}",
  "git fetch --quiet origin",
  "git rev-list --left-right --count HEAD...@{u}",
  "git status --porcelain --untracked-files=no",
  "git pull --ff-only --quiet",
  "npm ci",
];

/** Successful reply for one command against the behind checkout. */
export function behindCheckoutReply(command: string, args: string[]): ExecResult {
  const stdout = command === "git" ? (BEHIND_GIT_REPLIES[args.join(" ")] ?? "") : "ok";
  return { stdout, stderr: "", code: 0, killed: false };
}

/** Records every command line; `overrides` replace parts of the reply for one exact line. */
export function fakeExec(overrides: Record<string, Partial<ExecResult>> = {}) {
  const calls: string[] = [];
  const exec = vi.fn(async (command: string, args: string[]): Promise<ExecResult> => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    return { ...behindCheckoutReply(command, args), ...overrides[line] };
  });
  return { exec, calls };
}
