/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OMP_VERSION = "18.17.0";
export const BUN_VERSION = "1.4.4";

/** Never use PATH's omp or bun: both executable versions belong to this checkout. */
export function localOmpCommand(): string[] {
  const bun = path.join(ROOT, "node_modules", "bun", "bin", "bun.exe");
  const ompRoot = path.join(ROOT, "node_modules", "@oh-my-pi", "pi-coding-agent");
  if (!existsSync(bun))
    throw new Error("Repository-local Bun is missing. Run npm install, then npm rebuild bun.");
  const manifest = JSON.parse(readFileSync(path.join(ompRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (manifest.version !== OMP_VERSION)
    throw new Error(`Expected local OMP ${OMP_VERSION}; run npm ci.`);
  return [bun, path.join(ompRoot, "dist", "cli.js")];
}

/** OMP stays local; ordinary launches retain existing Salesforce authentication. */
export function runtimeEnvironment(stateRoot?: string): NodeJS.ProcessEnv {
  const state = path.resolve(stateRoot ?? path.join(ROOT, ".runtime"));
  const relative = path.relative(path.join(ROOT, ".runtime"), state);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("OMP state must remain inside this repository's .runtime directory.");
  }
  const home = path.join(state, "home");
  const agent = path.join(state, "omp", "agent");
  const cache = path.join(state, "cache");
  const config = path.join(state, "config");
  const data = path.join(state, "data");
  for (const dir of [home, agent, cache, config, data])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: agent,
    PI_CONFIG_DIR: path.relative(
      stateRoot === undefined ? os.homedir() : home,
      path.join(state, "omp"),
    ),
    PI_NATIVES_DIR: path.join(state, "omp", "natives"),
    BUN_INSTALL_CACHE_DIR: path.join(cache, "bun"),
    npm_config_cache: path.join(cache, "npm"),
    PATH: `${path.join(ROOT, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  // An explicit state root requests a hermetic, unauthenticated smoke environment.
  if (stateRoot !== undefined) {
    env.HOME = home;
    env.USERPROFILE = home;
    env.XDG_CACHE_HOME = cache;
    env.XDG_CONFIG_HOME = config;
    env.XDG_DATA_HOME = data;
    env.XDG_STATE_HOME = path.join(state, "state");
    delete env.SF_STATE_FOLDER;
    delete env.SFDX_STATE_FOLDER;
    for (const name of Object.keys(env)) {
      if (name.startsWith("OMP_AUTH_BROKER_")) delete env[name];
    }
  } else {
    env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = path.join(cache, "auth-broker-snapshot.enc");
    const toolchain = path.join(ROOT, ".runtime", "toolchains", "java");
    const javaHome =
      process.platform === "darwin" ? path.join(toolchain, "Contents", "Home") : toolchain;
    if (existsSync(path.join(javaHome, "bin", "java"))) {
      env.JAVA_HOME = javaHome;
      env.SF_LSP_JAVA = path.join(javaHome, "bin", "java");
      env.PATH = `${path.join(javaHome, "bin")}${path.delimiter}${env.PATH}`;
    }
  }
  // Global config overlays can include extensions; the auth bridge supplies
  // only its own policy overlay explicitly, never the inherited whole config.
  for (const name of [
    "OMP_PROFILE",
    "PI_PROFILE",
    "PI_SESSION_DIR",
    "PI_COMPILED",
    "PI_CONFIG_FILES",
  ])
    delete env[name];
  return env;
}
