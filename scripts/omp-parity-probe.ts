/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Parity-only probe: reports what native OMP actually registered for one
 * extension. Loaded before the target so a runtime-surface scenario's fixture
 * fetch, prerequisite tools, and provider keys are in place for its startup.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { RuntimeSurfaceScenarioModule } from "./runtime-surface/types.ts";

// Deferred registrations (session_start hooks, readiness timers) settle before the report.
const SETTLE_MS = 3_000;

export default async function parityProbe(pi: ExtensionAPI): Promise<void> {
  const reportPath = process.env.SF_OMP_PARITY_REPORT;
  const target = process.env.SF_OMP_PARITY_TARGET;
  if (!reportPath || !target) throw new Error("Run this probe through scripts/omp-parity.ts.");
  const targetDir = `${path.sep}extensions${path.sep}${target}${path.sep}`;
  const owned = (file: string | undefined) => typeof file === "string" && file.includes(targetDir);

  const [scenarioFile, scenarioName] = (process.env.SF_OMP_PARITY_SCENARIO ?? "").split("#");
  let scenario: RuntimeSurfaceScenarioModule["scenarios"][number] | undefined;
  if (scenarioFile) {
    // The scenario module path is selected per run by the parity runner.
    const module = (await import(scenarioFile)) as RuntimeSurfaceScenarioModule;
    scenario = module.scenarios.find((entry) => entry.name === scenarioName);
    if (!scenario) throw new Error(`Unknown runtime-surface scenario ${scenarioName}.`);
  }
  const fixtureFetch = scenario?.fetch;
  if (fixtureFetch) globalThis.fetch = Object.assign(fixtureFetch, globalThis.fetch);
  // External prerequisite tools (owned by other packages) are inert placeholders.
  for (const name of scenario?.activeTools ?? []) {
    pi.registerTool({
      name,
      label: name,
      description: `Parity placeholder for external prerequisite ${name}.`,
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        content: [{ type: "text", text: "Parity placeholder." }],
        details: undefined,
      }),
    } as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
  }

  pi.on("session_start", async (_event, ctx) => {
    // OMP's AuthStorage exposes writes through its CredentialsApi.
    for (const [provider, key] of Object.entries(scenario?.providerApiKeys ?? {})) {
      if (key)
        await ctx.modelRegistry.authStorage.credentials.set(provider, { type: "api_key", key });
    }
    // Report after the target's own session_start handlers (which run after this one).
    void (async () => {
      await Bun.sleep(SETTLE_MS);
      const tools = pi
        .getAllTools()
        .filter((tool) => owned(tool.sourceInfo?.path))
        .map((tool) => tool.name);
      const commands = pi
        .getCommands()
        .filter((command) => command.source === "extension" && owned(command.path))
        .map((command) => `/${command.name}`);
      await writeFile(reportPath, `${JSON.stringify({ tools, commands })}\n`);
    })();
  });
}
