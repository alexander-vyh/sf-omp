/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Repo-local SF Browser runtime: installs the pinned agent-browser CLI and its
 * Chrome for Testing under .runtime/toolchains/agent-browser (no global npm, no
 * download into the real HOME). scripts/omp-runtime.ts puts the result on every
 * OMP child's PATH. Idempotent: present pieces are reported, not reinstalled.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AGENT_BROWSER_HOME,
  AGENT_BROWSER_TOOLCHAIN,
  AGENT_BROWSER_VERSION,
  agentBrowserToolchain,
  ROOT,
} from "./omp-runtime.ts";

const CLI = "agent-browser";

function run(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd: AGENT_BROWSER_TOOLCHAIN, env, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
}

function installedVersion(): string | undefined {
  const manifest = path.join(AGENT_BROWSER_TOOLCHAIN, "node_modules", CLI, "package.json");
  if (!existsSync(manifest)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  const version =
    parsed !== null && typeof parsed === "object" && "version" in parsed
      ? parsed.version
      : undefined;
  return typeof version === "string" ? version : undefined;
}

mkdirSync(AGENT_BROWSER_HOME, { recursive: true, mode: 0o700 });
const projectManifest = path.join(AGENT_BROWSER_TOOLCHAIN, "package.json");
if (!existsSync(projectManifest)) {
  writeFileSync(projectManifest, `${JSON.stringify({ private: true }, null, 2)}\n`);
}
// npm keeps the real HOME so the user's registry/proxy config still applies. A local
// install keeps agent-browser's postinstall from rewriting any global bin entry.
const npmEnv = {
  ...process.env,
  npm_config_cache: path.join(ROOT, ".runtime", "cache", "npm"),
  npm_config_global: "false",
};

if (installedVersion() === AGENT_BROWSER_VERSION) {
  console.log(`${CLI} ${AGENT_BROWSER_VERSION}: already installed`);
} else {
  run(
    "npm",
    ["install", "--save-exact", "--no-audit", "--no-fund", `${CLI}@${AGENT_BROWSER_VERSION}`],
    npmEnv,
  );
}
const { binDir } = agentBrowserToolchain();
if (!binDir || installedVersion() !== AGENT_BROWSER_VERSION) {
  throw new Error(
    `${CLI} ${AGENT_BROWSER_VERSION} did not install into ${AGENT_BROWSER_TOOLCHAIN}`,
  );
}

if (agentBrowserToolchain().chrome) {
  console.log("Chrome for Testing: already installed");
} else {
  // agent-browser downloads into $HOME/.agent-browser/browsers; point HOME into .runtime.
  run(path.join(binDir, CLI), ["install"], { ...process.env, HOME: AGENT_BROWSER_HOME });
}
const { chrome } = agentBrowserToolchain();
if (!chrome) throw new Error(`Chrome for Testing did not install under ${AGENT_BROWSER_HOME}`);

console.log(
  [
    "",
    "SF Browser runtime provisioned:",
    `  ${CLI} ${AGENT_BROWSER_VERSION}: ${path.join(binDir, CLI)}`,
    `  Chrome for Testing: ${chrome}`,
    "OMP launched via bun scripts/omp.ts, npm run smoke:omp, or parity uses it automatically.",
  ].join("\n"),
);
