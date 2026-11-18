#!/usr/bin/env bun
/* SPDX-License-Identifier: Apache-2.0 */
/**
 * SF Pi → OMP parity gate. Loads every bundled extension, one per hermetic
 * native OMP process, and compares what OMP actually registered with the
 * extension manifest: commands, tools, providers, and supported events.
 *
 *   bun scripts/omp-parity.ts            report + compare with the baseline
 *   bun scripts/omp-parity.ts --update   rewrite the baseline from this run
 *
 * The baseline only ratchets: a regression fails, and an improvement fails
 * until the baseline is updated, so recorded parity never silently drops.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { OMP_VERSION, ROOT, localOmpCommand, runtimeEnvironment } from "./omp-runtime.ts";
import type { RuntimeSurfaceScenarioModule } from "./runtime-surface/types.ts";

const BASELINE_PATH = path.join(ROOT, "scripts", "omp-parity-baseline.json");
const PROBE_PATH = path.join(ROOT, "scripts", "omp-parity-probe.ts");
const OMP_TYPES = path.join(
  ROOT,
  "node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts",
);
const STARTUP_TIMEOUT_MS = 60_000;
const CONCURRENCY = 4;
const update = process.argv.includes("--update");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);

type Status = "pass" | "partial" | "load-failed" | "crashed";
interface Manifest {
  id: string;
  commands?: string[];
  tools?: string[];
  providers?: string[];
  events?: string[];
}
interface ExtensionResult {
  status: Status;
  missingCommands: string[];
  missingTools: string[];
  missingProviders: string[];
  unsupportedEvents: string[];
  loadError?: string;
}

const runRoot = path.join(
  ROOT,
  ".runtime",
  "parity",
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
);

async function supportedEvents(): Promise<Set<string>> {
  const source = await readFile(OMP_TYPES, "utf8");
  const names = [
    ...source.matchAll(/on\(event: "([a-z_]+)"/g),
    ...source.matchAll(/^\s+event: "([a-z_]+)",/gm),
  ].map((match) => match[1]);
  return new Set(names);
}

async function readManifests(): Promise<Manifest[]> {
  const dirs = await readdir(path.join(ROOT, "extensions"), { withFileTypes: true });
  const manifests = await Promise.all(
    dirs
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const text = await readFile(
          path.join(ROOT, "extensions", entry.name, "manifest.json"),
          "utf8",
        );
        return JSON.parse(text) as Manifest;
      }),
  );
  return manifests
    .filter((manifest) => !only || only.split(",").includes(manifest.id))
    .sort((left, right) => left.id.localeCompare(right.id));
}

interface RpcResponse {
  id?: string;
  type?: string;
  success?: boolean;
  data?: Record<string, unknown>;
}

interface Scenario {
  name: string;
  file?: string;
  env?: Record<string, string | undefined>;
  expectedTools: "manifest" | "none" | "subset";
}

async function scenariosFor(id: string): Promise<Scenario[]> {
  const file = path.join(ROOT, "extensions", id, "tests", "runtime-surface-scenarios.ts");
  if (!(await Bun.file(file).exists())) return [{ name: "default", expectedTools: "manifest" }];
  // Conditional tool surfaces declare their positive and negative startup cases here.
  const module = (await import(file)) as RuntimeSurfaceScenarioModule;
  return module.scenarios.map(({ name, env, expectedTools }) => ({
    name,
    file,
    env,
    expectedTools,
  }));
}

async function probe(
  manifest: Manifest,
  events: Set<string>,
  scenario: Scenario,
): Promise<ExtensionResult> {
  const dir = path.join(runRoot, manifest.id, scenario.name);
  const workspace = path.join(dir, "workspace");
  await mkdir(workspace, { recursive: true });
  const reportPath = path.join(dir, "probe.json");
  const env = runtimeEnvironment(path.join(dir, "state"));
  for (const key of Object.keys(env)) {
    if (
      /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|SF_TARGET_ORG|SFDX_DEFAULTUSERNAME)/i.test(
        key,
      )
    )
      delete env[key];
  }
  Object.assign(env, {
    OPENAI_API_KEY: "offline-parity-not-a-real-key",
    SF_OMP_PARITY_REPORT: reportPath,
    SF_OMP_PARITY_TARGET: manifest.id,
    SF_DISABLE_TELEMETRY: "true",
    SFDX_DISABLE_TELEMETRY: "true",
    CI: "true",
    ...(scenario.file ? { SF_OMP_PARITY_SCENARIO: `${scenario.file}#${scenario.name}` } : {}),
  });
  for (const [key, value] of Object.entries(scenario.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const child = Bun.spawn(
    [
      ...localOmpCommand(),
      "--mode",
      "rpc",
      "--no-ui",
      "--no-session",
      "--no-title",
      "--no-extensions",
      "--no-rules",
      "--no-context-files",
      "-e",
      PROBE_PATH,
      "-e",
      path.join(ROOT, "extensions", manifest.id, "index.ts"),
      "--provider",
      "openai",
      "--model",
      "gpt-4o-mini",
    ],
    { cwd: workspace, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const stderrText = new Response(child.stderr).text();
  const responses = new Map<string, RpcResponse>();
  const reader = (async () => {
    let buffer = "";
    for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += Buffer.from(chunk).toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        try {
          const message = JSON.parse(line) as RpcResponse;
          if (message.type === "response" && message.id) responses.set(message.id, message);
        } catch {
          // Non-JSON stdout is diagnostic only.
        }
      }
    }
  })();
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let report: { tools: string[]; commands: string[] } | undefined;
  while (!exited && Date.now() < deadline) {
    try {
      report = JSON.parse(await readFile(reportPath, "utf8"));
      break;
    } catch {
      await Bun.sleep(250);
    }
  }
  const requests = ["get_available_commands", "get_login_providers", "get_available_models"];
  if (report && !exited) {
    for (const type of requests) child.stdin.write(`${JSON.stringify({ id: type, type })}\n`);
    await child.stdin.flush();
    const requestDeadline = Date.now() + 15_000;
    while (!exited && Date.now() < requestDeadline && requests.some((id) => !responses.has(id)))
      await Bun.sleep(100);
  }
  child.stdin.end();
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  await child.exited;
  clearTimeout(killTimer);
  await reader;
  const stderr = await stderrText;
  await writeFile(path.join(dir, "omp.stderr.log"), stderr);

  const loadError = stderr
    .split("\n")
    .find((line) => line.includes("Failed to load extension"))
    ?.replace(/^.*Failed to load extension [^:]+: /, "")
    .slice(0, 300);
  const unsupportedEvents = (manifest.events ?? []).filter((event) => !events.has(event));
  const empty = {
    missingCommands: manifest.commands ?? [],
    missingTools: manifest.tools ?? [],
    missingProviders: manifest.providers ?? [],
    unsupportedEvents,
  };
  if (!report) {
    const crash = stderr
      .split("\n")
      .find((line) => /(?:TypeError|ReferenceError|SyntaxError|Error):/.test(line));
    return { status: "crashed", ...empty, loadError: (loadError ?? crash)?.trim().slice(0, 300) };
  }
  if (loadError) return { status: "load-failed", ...empty, loadError };

  const rpcCommands = new Set(
    ((responses.get("get_available_commands")?.data?.commands as { name: string }[]) ?? []).map(
      (command) => `/${command.name}`,
    ),
  );
  const loginProviders = new Set(
    ((responses.get("get_login_providers")?.data?.providers as { id: string }[]) ?? []).map(
      (provider) => provider.id,
    ),
  );
  const modelProviders = new Set(
    ((responses.get("get_available_models")?.data?.models as { provider: string }[]) ?? []).map(
      (model) => model.provider,
    ),
  );
  const commands = new Set([...report.commands, ...rpcCommands]);
  const tools = new Set(report.tools);
  const requiredTools = scenario.expectedTools === "manifest" ? (manifest.tools ?? []) : [];
  const missingCommands = (manifest.commands ?? []).filter((command) => !commands.has(command));
  const missingTools = [
    ...requiredTools.filter((tool) => !tools.has(tool)),
    // A negative scenario must not expose tools it is not ready to run.
    ...(scenario.expectedTools === "none" ? [...tools].map((tool) => `unexpected:${tool}`) : []),
  ];
  const missingProviders = (manifest.providers ?? []).filter(
    (provider) => !loginProviders.has(provider) && !modelProviders.has(provider),
  );
  const complete =
    missingCommands.length +
      missingTools.length +
      missingProviders.length +
      unsupportedEvents.length ===
    0;
  return {
    status: complete ? "pass" : "partial",
    missingCommands,
    missingTools,
    missingProviders,
    unsupportedEvents,
  };
}

const RANK: Record<Status, number> = { crashed: 0, "load-failed": 1, partial: 2, pass: 3 };
function gaps(result: ExtensionResult): string[] {
  return [
    ...result.missingCommands.map((name) => `command ${name}`),
    ...result.missingTools.map((name) => `tool ${name}`),
    ...result.missingProviders.map((name) => `provider ${name}`),
    ...result.unsupportedEvents.map((name) => `event ${name}`),
  ];
}

await mkdir(runRoot, { recursive: true });
const events = await supportedEvents();
const manifests = await readManifests();
const results: Record<string, ExtensionResult> = {};
const queue = [...manifests];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let manifest = queue.shift(); manifest; manifest = queue.shift()) {
      const scenarios = await scenariosFor(manifest.id);
      const runs: Array<[Scenario, ExtensionResult]> = [];
      for (const scenario of scenarios)
        runs.push([scenario, await probe(manifest, events, scenario)]);
      // The worst scenario sets the status; gaps name their scenario when there are several.
      const label = (name: string, scenario: Scenario) =>
        scenarios.length > 1 ? `${name} [${scenario.name}]` : name;
      const merged = (pick: (result: ExtensionResult) => string[]) => [
        ...new Set(
          runs.flatMap(([scenario, result]) => pick(result).map((name) => label(name, scenario))),
        ),
      ];
      const worst = runs.reduce((left, right) =>
        RANK[right[1].status] < RANK[left[1].status] ? right : left,
      )[1];
      results[manifest.id] = {
        status: worst.status,
        missingCommands: merged((result) => result.missingCommands),
        missingTools: merged((result) => result.missingTools),
        missingProviders: merged((result) => result.missingProviders),
        unsupportedEvents: [...new Set(runs.flatMap(([, result]) => result.unsupportedEvents))],
        ...(worst.loadError ? { loadError: worst.loadError } : {}),
      };
    }
  }),
);
const ordered = Object.fromEntries(
  Object.entries(results).sort(([left], [right]) => left.localeCompare(right)),
);
await writeFile(path.join(runRoot, "report.json"), `${JSON.stringify(ordered, null, 2)}\n`);

const passing = Object.values(ordered).filter((result) => result.status === "pass").length;
console.log(`OMP parity: ${passing}/${Object.keys(ordered).length} extensions complete`);
for (const [id, result] of Object.entries(ordered)) {
  const detail = result.loadError ?? gaps(result).join(", ");
  console.log(`[${result.status}] ${id}${detail ? ` — ${detail}` : ""}`);
}
console.log(`Logs: ${runRoot}`);

if (update) {
  const previous = only
    ? (JSON.parse(await readFile(BASELINE_PATH, "utf8")) as {
        extensions: Record<string, ExtensionResult>;
      })
    : { extensions: {} };
  const merged = { ...previous.extensions, ...ordered };
  const sorted = Object.fromEntries(
    Object.entries(merged).sort(([left], [right]) => left.localeCompare(right)),
  );
  const baseline = { schemaVersion: 1, ompVersion: OMP_VERSION, extensions: sorted };
  await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Baseline updated: ${path.relative(ROOT, BASELINE_PATH)}`);
} else {
  const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as {
    extensions: Record<string, ExtensionResult>;
  };
  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const [id, result] of Object.entries(ordered)) {
    const expected = baseline.extensions[id];
    if (!expected) {
      regressions.push(`${id}: not in baseline`);
      continue;
    }
    const before = new Set(gaps(expected));
    const after = new Set(gaps(result));
    const newGaps = [...after].filter((gap) => !before.has(gap));
    const closed = [...before].filter((gap) => !after.has(gap));
    if (RANK[result.status] < RANK[expected.status] || newGaps.length > 0)
      regressions.push(`${id}: ${expected.status} → ${result.status} ${newGaps.join(", ")}`.trim());
    else if (RANK[result.status] > RANK[expected.status] || closed.length > 0)
      improvements.push(`${id}: ${expected.status} → ${result.status} ${closed.join(", ")}`.trim());
  }
  for (const line of regressions) console.error(`REGRESSION ${line}`);
  for (const line of improvements) console.error(`IMPROVED ${line}`);
  if (improvements.length > 0)
    console.error("Parity improved; record it with: bun scripts/omp-parity.ts --update");
  process.exitCode = regressions.length + improvements.length > 0 ? 1 : 0;
}
