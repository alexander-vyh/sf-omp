/* SPDX-License-Identifier: Apache-2.0 */
/** Dedicated native OMP proof: real extension diagnostics, no org or model requests. */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import type * as LspClient from "../extensions/sf-lsp/lib/lsp-client.ts";
import type * as ApexDiagnostics from "../extensions/sf-apex/lib/diagnostics.ts";
import { ROOT } from "./omp-runtime.ts";

export default function lspSmoke(pi: ExtensionAPI): void {
  const reportPath = process.env.SF_OMP_LSP_REPORT;
  const workspace = process.env.SF_OMP_LSP_WORKSPACE;
  if (!reportPath || !workspace) throw new Error("Run scripts/omp-lsp-smoke.ts instead.");
  for (const value of [reportPath, workspace]) {
    if (!value.startsWith(`${ROOT}/.runtime/`)) throw new Error("LSP proof must stay repo-local.");
  }
  const report = {
    status: "failed",
    sessionStarted: false,
    sessionShutdown: false,
    checks: [] as Array<{ name: string; evidence: unknown }>,
    servers: [] as Array<{ pid: number; command: string; exited: boolean }>,
    error: "",
  };
  const persist = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  function captureServers(): void {
    const lines = execFileSync("ps", ["-ax", "-o", "pid=,ppid=,command="], {
      encoding: "utf8",
      timeout: 5_000,
    });
    for (const line of lines.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (
        !match ||
        Number(match[2]) !== process.pid ||
        !match[3].includes(path.join(ROOT, ".runtime", "omp", "agent", "lsp"))
      )
        continue;
      const pid = Number(match[1]);
      if (!report.servers.some((server) => server.pid === pid))
        report.servers.push({ pid, command: match[3], exited: false });
    }
  }
  pi.on("session_start", () => {
    report.sessionStarted = true;
    // Native OMP bounds session_start handlers; keep the RPC input open until persisted.
    void run().catch(async (error) => {
      report.error = String(error);
      await persist();
    });
  });
  pi.on("session_shutdown", async () => {
    report.sessionShutdown = true;
    await persist();
  });
  async function run(): Promise<void> {
    // Reuse plain module identities: separate reload graphs own separate client pools.
    const lsp = (await loadLegacyPiModule(path.join(ROOT, "extensions/sf-lsp/lib/lsp-client.ts"), {
      reload: false,
    })) as typeof LspClient;
    const apex = (await loadLegacyPiModule(
      path.join(ROOT, "extensions/sf-apex/lib/diagnostics.ts"),
      { reload: false },
    )) as typeof ApexDiagnostics;
    try {
      const doctor = await lsp.doctorLsp(workspace);
      for (const language of ["apex", "lwc"]) {
        const status = doctor.find((entry) => entry.language === language);
        if (!status?.available || !status.command?.includes(`${ROOT}/.runtime/`))
          throw new Error(`Non-local or unavailable ${language}: ${JSON.stringify(status)}`);
      }
      report.checks.push({
        name: "doctor.local-assets",
        evidence: doctor.filter((entry) => entry.language !== "agentscript"),
      });
      for (const [label, expected] of [
        ["Valid", "clean"],
        ["Invalid", "error"],
      ] as const) {
        const result = await apex.diagnoseFile(
          {
            action: "diagnose.file",
            file: path.join(workspace, `force-app/main/default/classes/Smoke${label}.cls`),
          },
          workspace,
        );
        captureServers();
        if (result.details?.ok !== true || result.details.status !== expected)
          throw new Error(`Apex ${label}: ${JSON.stringify(result)}`);
        if (label === "Valid" && (result.details.diagnostics as unknown[]).length !== 0)
          throw new Error(`Apex valid fixture has diagnostics: ${JSON.stringify(result)}`);
        report.checks.push({ name: `apex.${label.toLowerCase()}.diagnose.file`, evidence: result });
      }
      for (const label of ["Valid", "Invalid"] as const) {
        const file = path.join(
          workspace,
          `force-app/main/default/lwc/smoke${label}/smoke${label}.html`,
        );
        const result = await lsp.getLspDiagnosticsForFile("lwc", file, workspace, 6_000);
        captureServers();
        const errors = result.diagnostics.filter((entry) => entry.severity === 1);
        if (
          result.unavailable ||
          (label === "Valid" ? result.diagnostics.length !== 0 : errors.length === 0)
        )
          throw new Error(`LWC ${label}: ${JSON.stringify(result)}`);
        report.checks.push({ name: `lwc.${label.toLowerCase()}.lsp-diagnose`, evidence: result });
      }
      if (report.servers.length !== 2)
        throw new Error(`Expected two real server child processes, saw ${report.servers.length}.`);
      report.status = "pass";
    } catch (error) {
      report.error = String(error);
    } finally {
      captureServers();
      await lsp.shutdownLspClients();
      const deadline = Date.now() + 5_000;
      do {
        for (const server of report.servers) {
          try {
            process.kill(server.pid, 0);
          } catch (error) {
            // Only ESRCH proves exit; any other code leaves the server counted as alive.
            if ((error as NodeJS.ErrnoException).code === "ESRCH") server.exited = true;
          }
        }
        if (report.servers.every((server) => server.exited)) break;
        await Bun.sleep(50);
      } while (Date.now() < deadline);
      if (!report.servers.every((server) => server.exited)) {
        report.status = "failed";
        report.error += " Language-server child process remained alive.";
      }
      await persist();
    }
  }
}
