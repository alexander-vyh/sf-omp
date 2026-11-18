/* SPDX-License-Identifier: Apache-2.0 */
/**
 * macOS arm64 Salesforce LSP provisioning; HOME/XDG and global OMP stay untouched.
 * Run each bounded phase separately with node_modules/bun/bin/bun.exe:
 *   scripts/provision-salesforce-lsp.ts java-download|java-install|apex|lwc
 * Then run scripts/omp-lsp-smoke.ts with the same Bun executable.
 * Archives and npm's cache stay in .runtime; no root dependency changes.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ROOT } from "./omp-runtime.ts";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("These pinned Java assets are for macOS arm64 only.");
}
const downloads = path.join(ROOT, ".runtime", "downloads");
const toolchains = path.join(ROOT, ".runtime", "toolchains");
const lsp = path.join(ROOT, ".runtime", "omp", "agent", "lsp");
for (const directory of [downloads, toolchains, lsp]) mkdirSync(directory, { recursive: true });
const javaArchive = "OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.13_9.tar.gz";
const javaSha = "bf036b35b071bfb2f54f2c0af8ee8d88afa95ee6eb3dce02c0f94cfc2524d04a";
const apexVersion = "68.9.6";
const apexSha = "721c2ffd61d8df37adad13eabbd1b19c93819b5728c78a5966f0ea9188e3ac85";
const jarSha = "4477f6c5e4c79bb7fe13e77cbcd77b25e0d4f5b730a7b4036b1031c274221d55";
const lwcVersion = "4.12.13";
const lwcSha = "711f93a626a0fe1495bc6ab25fb09cd9f141e5949d366f9fc893ab1a03883e4a";
function run(command: string, args: string[], env = process.env): Buffer {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env,
    timeout: 110_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command}: ${result.error ?? result.stderr.toString()}`);
  return result.stdout;
}
function verify(file: string, expected: string): void {
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${file}: ${actual}`);
  console.log(`${expected}  ${file}`);
}
function download(name: string, url: string, sha: string): string {
  const file = path.join(downloads, name);
  if (!existsSync(file)) {
    const partial = `${file}.partial`;
    run("curl", [
      "-fsSL",
      "--compressed",
      "--connect-timeout",
      "10",
      "--max-time",
      "100",
      url,
      "-o",
      partial,
    ]);
    verify(partial, sha);
    renameSync(partial, file);
  }
  verify(file, sha);
  return file;
}
switch (process.argv[2]) {
  case "java-download":
    download(
      javaArchive,
      `https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/${javaArchive}`,
      javaSha,
    );
    break;
  case "java-install": {
    const archive = path.join(downloads, javaArchive);
    verify(archive, javaSha);
    const temporary = mkdtempSync(path.join(toolchains, ".java-"));
    try {
      run("tar", ["-xzf", archive, "-C", temporary]);
      const extracted = path.join(temporary, "jdk-21.0.13+9");
      const target = path.join(toolchains, "java");
      if (existsSync(target)) {
        // Never overwrite an existing toolchain; verify its executable and runtime instead.
        for (const file of ["release", "bin/java", "lib/modules"]) {
          const relative = path.join("Contents", "Home", file);
          const expected = createHash("sha256")
            .update(readFileSync(path.join(extracted, relative)))
            .digest("hex");
          verify(path.join(target, relative), expected);
        }
      } else renameSync(extracted, target);
      run(path.join(target, "Contents", "Home", "bin", "java"), ["-version"]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    break;
  }
  case "apex": {
    const archive = download(
      `salesforcedx-vscode-apex-${apexVersion}.vsix`,
      `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/salesforce/vsextensions/salesforcedx-vscode-apex/${apexVersion}/vspackage`,
      apexSha,
    );
    const directory = path.join(lsp, "apex");
    mkdirSync(directory, { recursive: true });
    const jar = path.join(directory, "apex-jorje-lsp.jar");
    const temporary = `${jar}.partial`;
    writeFileSync(temporary, run("unzip", ["-p", archive, "extension/dist/apex-jorje-lsp.jar"]));
    verify(temporary, jarSha);
    renameSync(temporary, jar);
    writeFileSync(path.join(directory, "VERSION"), `${apexVersion}\n`);
    break;
  }
  case "lwc": {
    const archive = download(
      `lwc-language-server-${lwcVersion}.tgz`,
      `https://registry.npmjs.org/@salesforce/lwc-language-server/-/lwc-language-server-${lwcVersion}.tgz`,
      lwcSha,
    );
    const directory = path.join(lsp, "lwc");
    mkdirSync(directory, { recursive: true });
    if (!existsSync(path.join(directory, "package.json")))
      writeFileSync(path.join(directory, "package.json"), '{"private":true}\n');
    run(
      "npm",
      [
        "install",
        "--prefix",
        directory,
        "--save-exact",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        archive,
      ],
      {
        ...process.env,
        npm_config_cache: path.join(ROOT, ".runtime", "cache", "npm"),
        npm_config_global: "false",
      },
    );
    const installed = JSON.parse(
      readFileSync(
        path.join(directory, "node_modules", "@salesforce", "lwc-language-server", "package.json"),
        "utf8",
      ),
    );
    if (installed.version !== lwcVersion)
      throw new Error(`Unexpected LWC version: ${installed.version}`);
    break;
  }
  default:
    throw new Error("Choose java-download, java-install, apex, or lwc.");
}
console.log(`Provisioned ${process.argv[2]} inside ${ROOT}/.runtime only.`);
