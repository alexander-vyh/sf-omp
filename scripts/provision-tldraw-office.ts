/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Repo-local sf-tldraw runtime: downloads the pinned, Developer ID-signed tldraw office
 * macOS release zip from GitHub, verifies its sha256 and code signature, and extracts it
 * under .runtime/toolchains/tldraw-office/<version>. No /Applications, no global state.
 * Idempotent: an already verified install is reported, not re-downloaded.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tldrawOfficeToolchain } from "./omp-runtime.ts";

const RELEASE = "https://github.com/tldraw/tldraw-office/releases/download";
// sha256 digests published by the GitHub release API for v1.24.1 assets.
const ASSETS: Record<string, { name: string; sha256: string }> = {
  arm64: {
    name: "tldraw-office-mac-arm64.zip",
    sha256: "b8e00c82e3f69f0a1448c8efd2d7e482395381fffe21a520fc1ab886246f05ef",
  },
  x64: {
    name: "tldraw-office-mac-x64.zip",
    sha256: "b9e7d309699458be4a48b84e9ae2b74401b2187cf602d39b341386a251025300",
  },
};

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.status}`);
  }
  return `${result.stdout}${result.stderr}`;
}

// The archive bytes are already pinned by sha256; the signature check confirms
// the unpacked app is Developer ID-signed by tldraw and accepted by Gatekeeper.
function verifySignature(app: string): void {
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const details = run("codesign", ["-dv", "--verbose=2", app]);
  if (!details.includes("Authority=Developer ID Application: tldraw GB Ltd. (")) {
    throw new Error(`${app} is not Developer ID-signed by tldraw GB Ltd.`);
  }
  run("spctl", ["--assess", "--type", "execute", app]);
}

if (process.platform !== "darwin") throw new Error("tldraw office provisioning is macOS-only.");
const asset = ASSETS[process.arch];
if (!asset) throw new Error(`No pinned tldraw office build for ${process.arch}.`);
const toolchain = tldrawOfficeToolchain();

if (toolchain.executable) {
  verifySignature(toolchain.app);
  console.log(`tldraw office ${toolchain.version}: already installed`);
} else {
  const versionDir = path.dirname(toolchain.app);
  mkdirSync(path.dirname(versionDir), { recursive: true });
  const staging = mkdtempSync(path.join(path.dirname(versionDir), ".staging-"));
  try {
    const url = `${RELEASE}/v${toolchain.version}/${asset.name}`;
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) {
      throw new Error(`sha256 mismatch for ${asset.name}: ${digest}`);
    }
    const zip = path.join(staging, asset.name);
    writeFileSync(zip, bytes);
    run("ditto", ["-x", "-k", zip, staging]);
    rmSync(zip);
    verifySignature(path.join(staging, path.basename(toolchain.app)));
    rmSync(versionDir, { recursive: true, force: true });
    renameSync(staging, versionDir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const installed = tldrawOfficeToolchain();
if (!installed.executable) throw new Error(`tldraw office did not install at ${installed.app}`);
console.log(
  [
    "",
    "sf-tldraw runtime provisioned:",
    `  tldraw office ${installed.version}: ${installed.app}`,
    "npm run smoke:omp launches it hidden with a hermetic data directory for real renders.",
  ].join("\n"),
);
