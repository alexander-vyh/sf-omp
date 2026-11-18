/* SPDX-License-Identifier: Apache-2.0 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageManifest from "../package.json" with { type: "json" };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OMP_VERSION = packageManifest.devDependencies["@oh-my-pi/pi-coding-agent"];
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

/** Pinned agent-browser release installed by scripts/provision-agent-browser.ts. */
export const AGENT_BROWSER_VERSION = "0.43.0";
export const AGENT_BROWSER_TOOLCHAIN = path.join(ROOT, ".runtime", "toolchains", "agent-browser");
/** HOME used only for the provisioning download, so Chrome for Testing lands in .runtime. */
export const AGENT_BROWSER_HOME = path.join(AGENT_BROWSER_TOOLCHAIN, "home");

/** The provisioned CLI's bin directory and Chrome binary, when present. */
export function agentBrowserToolchain(): { binDir?: string; chrome?: string } {
  const binDir = path.join(AGENT_BROWSER_TOOLCHAIN, "node_modules", ".bin");
  const browsers = path.join(AGENT_BROWSER_HOME, ".agent-browser", "browsers");
  const app = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  // Same layouts agent-browser's own lookup accepts (cli/src/install.rs).
  const chrome = (existsSync(browsers) ? readdirSync(browsers) : [])
    .filter((name) => name.startsWith("chrome-"))
    .sort()
    .reverse()
    .flatMap((name) =>
      ["", "chrome-mac-arm64", "chrome-mac-x64"].map((inner) =>
        path.join(browsers, name, inner, app),
      ),
    )
    .find((candidate) => existsSync(candidate));
  return {
    ...(existsSync(path.join(binDir, "agent-browser")) ? { binDir } : {}),
    ...(chrome ? { chrome } : {}),
  };
}

/**
 * Pinned tldraw office desktop app (the real sf-tldraw Canvas API runtime) installed by
 * `bun scripts/provision-tldraw-office.ts` under .runtime/toolchains/tldraw-office/<version>.
 * The sf-tldraw smoke check launches it hidden with a hermetic TEST_DATA_DIR when present.
 */
export function tldrawOfficeToolchain(): { version: string; app: string; executable?: string } {
  const version = "1.24.1";
  const app = path.join(
    ROOT,
    ".runtime",
    "toolchains",
    "tldraw-office",
    version,
    "tldraw office.app",
  );
  const executable = path.join(app, "Contents", "MacOS", "tldraw office");
  return { version, app, ...(existsSync(executable) ? { executable } : {}) };
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
    // Without a key.json in the empty HOME, @salesforce/core falls back to the
    // real macOS login keychain (not HOME-scoped) and can block; hermetic runs
    // keep their key under the fake HOME instead.
    env.SF_USE_GENERIC_UNIX_KEYCHAIN = "true";
    for (const name of Object.keys(env)) {
      if (name.startsWith("OMP_AUTH_BROKER_")) delete env[name];
    }
    // agent-browser's daemon socket defaults to $HOME/.agent-browser; a hermetic HOME
    // under .runtime/smoke/<run>/state exceeds macOS's 103-byte socket path limit.
    const socketKey = createHash("sha256").update(state).digest("hex").slice(0, 8);
    env.AGENT_BROWSER_SOCKET_DIR = path.join(ROOT, ".runtime", "ab", socketKey);
    mkdirSync(env.AGENT_BROWSER_SOCKET_DIR, { recursive: true, mode: 0o700 });
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
  // SF Browser shells out to agent-browser. A copy provisioned by
  // `bun scripts/provision-agent-browser.ts` (pinned CLI plus Chrome for Testing,
  // all under .runtime/toolchains/agent-browser) takes precedence over a global
  // install so launcher, smoke, and parity use the same audited browser runtime.
  const agentBrowser = agentBrowserToolchain();
  if (agentBrowser.binDir) env.PATH = `${agentBrowser.binDir}${path.delimiter}${env.PATH}`;
  if (agentBrowser.chrome) env.AGENT_BROWSER_EXECUTABLE_PATH ??= agentBrowser.chrome;
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
  // @salesforce/core's file logger starts a pino transport whose relative target
  // pino resolves from caller stack paths; inside OMP's extension loader that
  // fails, so every in-process org connection would throw. Memory logging keeps
  // org features working; an explicit user setting still wins.
  env.SF_DISABLE_LOG_FILE ??= "true";
  return env;
}
