/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Hermetic launcher for the pinned native OMP host in runtime proofs.
 *
 * Runs the exact `@oh-my-pi/pi-coding-agent` devDependency through the
 * repository's Bun (CI has no global `omp`). Each host gets its own HOME, XDG
 * and agent directories and inherits no credentials, auth broker or profile.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { localOmpCommand } from "../../../scripts/omp-runtime.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const FIXTURES = path.join(REPO_ROOT, "lib", "common", "tests", "fixtures");

/** Load only explicit `-e` extensions: no ambient extensions, skills, rules, context files or session file. */
export const OMP_ISOLATION_ARGS = [
  "--offline",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-context-files",
  "--no-title",
  "--no-session",
];

/** In-process model that answers "done", so no turn can reach a network provider. */
export const OMP_OFFLINE_MODEL_ARGS = [
  "-e",
  path.join(FIXTURES, "offline-provider.ts"),
  "--model",
  "sf-omp-offline/probe",
];

/** Extension that writes the session's entries to `SF_OMP_PROBE_ENTRIES` at shutdown. */
export const OMP_SESSION_ENTRIES_PROBE = path.join(FIXTURES, "session-entries-probe.ts");

export interface OmpTestHost {
  /** argv prefix: the repository's Bun running the pinned OMP CLI. */
  command: string[];
  /** `PI_CODING_AGENT_DIR`: OMP's config.yml plus extension state. */
  agentDir: string;
  env: Record<string, string>;
}

/** Fresh host state under `root`; `extraEnv` is applied last. */
export function ompTestHost(root: string, extraEnv: Record<string, string> = {}): OmpTestHost {
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  // Process basics only: API keys, tokens, auth brokers and profiles never pass through.
  const env: Record<string, string> = {};
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    command: localOmpCommand(),
    agentDir,
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      PI_CODING_AGENT_DIR: agentDir,
      ...extraEnv,
    },
  };
}
