/* SPDX-License-Identifier: Apache-2.0 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type * as OfficialLsp from "@sf-agentscript/lsp";

type AgentforceLsp = Pick<
  typeof OfficialLsp,
  "processDocument" | "provideCodeActions" | "provideRename"
>;

let lsp: Promise<AgentforceLsp> | undefined;

export function loadAgentforceLsp(): Promise<AgentforceLsp> {
  return (lsp ??= importAgentforceLsp());
}

async function importAgentforceLsp(): Promise<AgentforceLsp> {
  if ("Bun" in globalThis) {
    // OMP's Bun-only host helpers and standalone bundle are absent under Node.
    const { getAgentDir, isCompiledBinary } = await import("@oh-my-pi/pi-utils");
    if (isCompiledBinary()) return bundleAgentforceLsp(getAgentDir());
  }
  // The official LSP is expensive and is only needed for Agent Script work.
  return import("@sf-agentscript/lsp");
}

async function bundleAgentforceLsp(agentDir: string): Promise<AgentforceLsp> {
  // The standalone executable's resolver misses nested CommonJS package exports.
  // Build the official functions under Node, then load the resulting module in OMP.
  const script = fileURLToPath(new URL("./agentforce-lsp-entry.mjs", import.meta.url));

  await mkdir(agentDir, { recursive: true });
  const dir = await mkdtemp(join(agentDir, "sf-agentscript-lsp-"));
  try {
    const modulePath = join(dir, "lsp.mjs");
    await promisify(execFile)("node", [script, modulePath]);
    return (await import(pathToFileURL(modulePath).href)) as AgentforceLsp;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
