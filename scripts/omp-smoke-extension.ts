/* SPDX-License-Identifier: Apache-2.0 */
/** Smoke-only adapter: forwards real registrations and native hooks, then calls real tools. */
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { getAgentDir, getConfigRootDir, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSkills,
  rediscoverSkills,
  Settings,
  type ExtensionAPI,
  type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { importExtensionModule } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { parseSoql } from "../extensions/sf-soql/lib/parser.ts";
import { updateSkillSources } from "../lib/common/skill-sources/skill-sources.ts";
import { skillSettingsValues } from "../lib/common/skill-sources/skill-settings.ts";
import { buildSkillInventory } from "../lib/common/skill-detection/detection.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Smoke loads exactly what the launcher loads: the root manifest's extension list.
const selected = (
  JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    pi: { extensions: string[] };
  }
).pi.extensions.map((entry) => entry.split("/")[2]);
const CHECKS_DIR = path.join(root, "scripts", "omp-smoke-checks");
type Status = "pass" | "failed" | "blocked" | "not-tested";

/**
 * Contract for per-extension check modules in scripts/omp-smoke-checks/<id>.ts.
 * A module's default export receives this API and records checks through `run`
 * (or `skip` for an explicit blocked/not-tested prerequisite). Checks invoke the
 * real registered tools with the genuine host context; no network is allowed.
 */
export interface SmokeApi {
  pi: ExtensionAPI;
  ctx: unknown;
  workspace: string;
  file(relative: string): string;
  run(name: string, extension: string, action: () => Promise<unknown>): Promise<void>;
  skip(name: string, extension: string, status: "blocked" | "not-tested", reason: string): void;
  invoke(name: string, params: Record<string, unknown>): Promise<unknown>;
  requireSuccess(name: string, params: Record<string, unknown>): Promise<unknown>;
  requireTrue(condition: unknown, message: string): asserts condition;
  details(result: unknown): Record<string, unknown>;
  /** The extension's real `pi.on(event, …)` handlers, in registration order (smoke-wrapped). */
  handlers(extension: string, event: string): SmokeHandler[];
  /** The real `pi.registerCommand(name, …)` definition, with its owning extension. */
  command(name: string): SmokeCommand | undefined;
  /**
   * Run a real registered slash command with the host ctx (hasUI=false unless overridden)
   * and capture what it surfaced: ui.notify calls and session entries it appended.
   */
  runCommand(name: string, args: string, options?: { hasUI?: boolean }): Promise<CommandOutput>;
}
export interface CommandOutput {
  notifications: Array<{ message: string; level: string }>;
  /** console.info/log lines: headless commands print their body like print mode. */
  stdout: string[];
  entries: Array<{ customType?: string; data?: unknown }>;
  /** notifications plus entry titles/bodies as one searchable string. */
  text: string;
}
export type SmokeHandler = (event: unknown, ctx: unknown) => Promise<unknown>;
export interface SmokeCommand {
  extension: string;
  name: string;
  handler: (args: string, ctx: unknown) => Promise<unknown>;
  getArgumentCompletions?: (prefix: string) => unknown;
}
interface Check {
  name: string;
  extension: string;
  status: Status;
  evidence?: unknown;
  reason?: string;
  /** Wall time of the check action; absent for recorded skips. */
  durationMs?: number;
}
interface Loaded {
  name: string;
  loaded: boolean;
  registrations: number;
  tools: string[];
  registeredHooks: string[];
  nativeHooks: Record<string, number>;
  error?: string;
}
interface CapturedTool {
  execute: (...args: unknown[]) => unknown;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
function requireTrue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function details(result: unknown): Record<string, unknown> {
  return record(record(result).details);
}
function toolSucceeded(result: unknown): boolean {
  return record(result).isError !== true && details(result).ok !== false;
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export default async function smoke(pi: ExtensionAPI): Promise<void> {
  const reportPath = process.env.SF_OMP_SMOKE_REPORT;
  const workspace = process.env.SF_OMP_SMOKE_WORKSPACE;
  requireTrue(
    reportPath && workspace,
    "Run this smoke-only extension through scripts/omp-smoke.ts.",
  );
  requireTrue(
    reportPath.startsWith(`${root}${path.sep}.runtime${path.sep}`),
    "Smoke report must be repo-local.",
  );
  requireTrue(
    workspace.startsWith(`${root}${path.sep}.runtime${path.sep}`),
    "Smoke workspace must be repo-local.",
  );
  const loaded: Loaded[] = [];
  const checks: Check[] = [];
  const hookErrors: Array<{ extension: string; event: string; error: string }> = [];
  const tools = new Map<string, CapturedTool>();
  const hookHandlers = new Map<string, SmokeHandler[]>();
  const commands = new Map<string, SmokeCommand>();
  const blockedFetches: string[] = [];
  let sessionStarted = false;
  let sessionShutdown = false;

  // No fake service responses: an accidental network call is rejected, not simulated.
  // These checks never call org operations or submit an OMP prompt.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const input = args[0];
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/^https?:/i.test(url)) {
      blockedFetches.push(url.replace(/\?.*$/, ""));
      throw new Error("Outbound fetch disabled by the offline OMP smoke extension.");
    }
    return originalFetch(...args);
  }, originalFetch);

  for (const name of selected) {
    const entry: Loaded = {
      name,
      loaded: false,
      registrations: 0,
      tools: [],
      registeredHooks: [],
      nativeHooks: {},
    };
    loaded.push(entry);
    const proxy = new Proxy(pi, {
      get(target, property, receiver) {
        const member: unknown = Reflect.get(target, property, receiver);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          if (
            typeof property === "string" &&
            (property.startsWith("register") || property === "on")
          )
            entry.registrations++;
          if (property === "registerTool") {
            const definition = record(args[0]);
            const execute = definition.execute;
            if (typeof definition.name === "string" && typeof execute === "function") {
              entry.tools.push(definition.name);
              tools.set(definition.name, {
                execute: (...values) => Reflect.apply(execute, args[0], values),
              });
            }
          }
          if (property === "registerCommand" && typeof args[0] === "string") {
            const definition = record(args[1]);
            const handler = definition.handler;
            const completions = definition.getArgumentCompletions;
            if (typeof handler === "function") {
              commands.set(args[0], {
                extension: name,
                name: args[0],
                handler: async (...values) => await Reflect.apply(handler, args[1], values),
                ...(typeof completions === "function"
                  ? {
                      getArgumentCompletions: (prefix: string) =>
                        Reflect.apply(completions, args[1], [prefix]),
                    }
                  : {}),
              });
            }
          }
          if (property === "on" && typeof args[0] === "string" && typeof args[1] === "function") {
            const event = args[0];
            entry.registeredHooks.push(event);
            const handler = args[1];
            args[1] = async (...values: unknown[]) => {
              try {
                const result: unknown = await Reflect.apply(handler, undefined, values);
                entry.nativeHooks[event] = (entry.nativeHooks[event] ?? 0) + 1;
                return result;
              } catch (error) {
                hookErrors.push({ extension: name, event, error: errorText(error) });
                throw error;
              }
            };
            const key = `${name}\u0000${event}`;
            hookHandlers.set(key, [...(hookHandlers.get(key) ?? []), args[1] as SmokeHandler]);
          }
          return Reflect.apply(member, target, args);
        };
      },
    });
    try {
      // OMP's own loader applies the legacy Pi import remapping (shims), exactly as
      // a normal `-e` load does; a plain import() would bind the Pi SDK instead.
      const prepared = await importExtensionModule(
        path.join(root, "extensions", name, "index.ts"),
        root,
      );
      requireTrue(prepared.factory, prepared.error ?? `${name} has no extension factory.`);
      await Reflect.apply(prepared.factory, undefined, [proxy]);
      entry.loaded = true;
    } catch (error) {
      entry.error = errorText(error);
    }
  }

  async function persist(): Promise<void> {
    const failed = checks.filter((check) => check.status === "failed").length + hookErrors.length;
    const report = {
      schemaVersion: 1,
      finishedAt: new Date().toISOString(),
      status: sessionStarted && failed === 0 ? "pass" : "failed",
      workspace,
      sessionStarted,
      sessionShutdown,
      selectedExtensions: loaded.map((entry) => ({
        ...entry,
        locallyExercised: checks
          .filter(
            (check) =>
              check.extension === entry.name &&
              check.status === "pass" &&
              !check.name.endsWith("startup"),
          )
          .map((check) => check.name),
        liveBehavior: "not-tested",
      })),
      checks,
      hookErrors,
      blockedFetches,
      limitations: [
        "Native OMP session_start/session_shutdown hooks and real registration APIs are used; tool functions receive the genuine host ExtensionContext.",
        "Tool execute functions and registered event/command handlers are invoked directly with the host ctx: model tool selection and OMP's own tool_call/tool_result/session_stop dispatch order are not exercised here.",
        "No prompt or model request is submitted. Dummy OpenAI selection/key creates the host context only.",
        "No Salesforce org authentication, API calls, deploy/activate, Agentforce preview/eval, live schema grounding, Apex execution or tests are attempted.",
        "SOQL is the extension's actual parser called directly: the ordinary registered sf_soql tool connects to an org before dispatch.",
        "Apex diagnostics require an already provisioned repo-isolated language server; missing prerequisites are blocked, never installed here.",
        "Code Analyzer scans, managed LSP installation/diagnostics and managed skill downloads/catalog UI need prerequisites absent from the isolated state; their hooks are checked up to that boundary.",
        "Outbound fetch is rejected in this child after smoke extension activation; this is not an OS-level network sandbox.",
      ],
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  // OMP bounds each session_start handler (EXTENSION_HANDLER_TIMEOUT_MS, 30s), so the
  // checks run detached; the runner persists the report and shuts the session down.
  pi.on("session_start", (_event, ctx) => {
    sessionStarted = true;
    void runChecks(ctx);
  });
  async function runChecks(ctx: ExtensionContext): Promise<void> {
    async function run(
      name: string,
      extension: string,
      action: () => Promise<unknown>,
    ): Promise<void> {
      const started = performance.now();
      try {
        const evidence = await action();
        const durationMs = Math.round(performance.now() - started);
        checks.push({ name, extension, status: "pass", evidence, durationMs });
      } catch (error) {
        const durationMs = Math.round(performance.now() - started);
        checks.push({ name, extension, status: "failed", reason: errorText(error), durationMs });
      }
    }
    async function invoke(name: string, params: Record<string, unknown>): Promise<unknown> {
      const tool = tools.get(name);
      requireTrue(
        tool,
        `Expected actual registered tool ${name}; extension load/version gate may have failed.`,
      );
      return await tool.execute(
        `omp-smoke-${checks.length}`,
        params,
        new AbortController().signal,
        undefined,
        ctx,
      );
    }
    async function requireSuccess(name: string, params: Record<string, unknown>): Promise<unknown> {
      const result = await invoke(name, params);
      requireTrue(toolSucceeded(result), `${name} returned an error: ${JSON.stringify(result)}`);
      return result;
    }
    const file = (relative: string) => path.join(workspace, relative);
    try {
      await run("omp.native.isolation", "runtime", async () => {
        const stateRoot = process.env.SF_OMP_SMOKE_STATE_ROOT;
        const expectedConfigRoot = process.env.SF_OMP_SMOKE_CONFIG_ROOT;
        const expectedCli = process.env.SF_OMP_SMOKE_CLI;
        const nativeConfigRoot = path.resolve(getConfigRootDir());
        const nativeAgentDir = path.resolve(getAgentDir());
        requireTrue(
          stateRoot && expectedConfigRoot && expectedCli,
          "Missing launcher isolation contract.",
        );
        requireTrue(
          nativeConfigRoot === path.resolve(expectedConfigRoot),
          `Unexpected native OMP config root: ${nativeConfigRoot}`,
        );
        requireTrue(
          nativeConfigRoot.startsWith(`${stateRoot}${path.sep}`) &&
            nativeAgentDir.startsWith(`${stateRoot}${path.sep}`),
          "Native OMP configuration or agent state escaped isolated stateRoot.",
        );
        const nativeCacheRoot = process.env.PI_NATIVES_DIR;
        requireTrue(
          nativeCacheRoot === path.join(stateRoot, "omp", "natives"),
          "Native addon cache escaped isolated stateRoot.",
        );
        const actualCli = await realpath(process.argv[1] ?? "");
        requireTrue(
          actualCli === (await realpath(expectedCli)),
          `Unexpected OMP CLI entrypoint: ${actualCli}`,
        );
        return {
          nativeConfigRoot,
          nativeAgentDir,
          nativeCacheRoot,
          actualCli,
          executable: process.execPath,
          home: process.env.HOME,
        };
      });
      await run("omp.native.legacy-shim", "runtime", async () => {
        // Extensions are loaded through the same remapping; inside that graph the
        // Pi SDK specifier must resolve to OMP's legacy shim, not Pi 1.x.
        const compat = record(
          await loadLegacyPiModule(path.join(root, "lib", "common", "pi-compat.ts")),
        );
        const version = Reflect.apply(compat.getInstalledPiVersion as () => unknown, undefined, []);
        requireTrue(
          version === "18.17.0",
          `Extension graph resolved the Pi SDK version ${String(version)}, not the OMP shim.`,
        );
        return { installedPiVersionInExtensionGraph: version };
      });
      for (const entry of loaded) {
        await run(`${entry.name}.startup`, entry.name, async () => {
          requireTrue(entry.loaded, entry.error ?? "Factory did not finish.");
          requireTrue(
            entry.registrations > 0,
            "Factory returned without registrations (possible version gate).",
          );
          if (entry.registeredHooks.includes("session_start")) {
            const expected = entry.registeredHooks.filter(
              (event) => event === "session_start",
            ).length;
            requireTrue(
              entry.nativeHooks.session_start === expected,
              "Not all native session_start hooks completed.",
            );
          }
          return {
            registrations: entry.registrations,
            tools: entry.tools,
            registeredHooks: entry.registeredHooks,
            nativeHooks: entry.nativeHooks,
          };
        });
      }
      await run("skills.native.command-discovery", "sf-skills", async () => {
        // OMP spells macOS /private/tmp paths as /tmp, so match the real location.
        const skillPath = resolveEquivalentPath(file(".omp/skills/sf-omp-startup-smoke/SKILL.md"));
        const command = pi
          .getCommands()
          .find(
            (entry) =>
              entry.source === "skill" &&
              entry.path !== undefined &&
              resolveEquivalentPath(entry.path) === skillPath,
          );
        requireTrue(
          command?.path,
          `Native OMP did not expose the startup skill path: ${JSON.stringify(pi.getCommands())}`,
        );
        const inventory = buildSkillInventory(pi.getCommands(), workspace);
        requireTrue(
          inventory.byFilePath.get(command.path)?.commandName === command.name,
          "Skill tracking did not retain native command provenance.",
        );
        return command;
      });
      await run("agentscript.valid.compile.check", "sf-agentscript", async () => {
        const result = await requireSuccess("agentscript_authoring", {
          verb: "compile",
          mode: "check",
          agent_file: file("NativeLocal.agent"),
          fallback: "none",
        });
        requireTrue(
          details(result).clean === true && details(result).compiled_via === "local",
          `Expected clean local AgentScript compile: ${JSON.stringify(result)}`,
        );
        return result;
      });
      await run("agentscript.invalid.compile.check", "sf-agentscript", async () => {
        const result = await requireSuccess("agentscript_authoring", {
          verb: "compile",
          mode: "check",
          agent_file: file("Invalid.agent"),
          fallback: "none",
        });
        requireTrue(
          details(result).clean === false && Number(details(result).diagnostic_count) > 0,
          `Expected AgentScript compile diagnostics: ${JSON.stringify(result)}`,
        );
        return result;
      });
      await run("apex.author.plan", "sf-apex", async () => {
        const result = await requireSuccess("sf_apex", {
          action: "author.plan",
          target: "SmokeValid",
          intent: "Return a constant greeting without queries or DML.",
        });
        requireTrue(details(result).kind === "author_plan", "Expected actual Apex authoring plan.");
        return result;
      });
      await run("apex.log.analyze", "sf-apex", async () => {
        const result = await requireSuccess("sf_apex", {
          action: "log.analyze",
          file: file("apex-debug.txt"),
        });
        const counts = record(record(details(result).log_digest).counts);
        requireTrue(
          counts.user_debug === 1 && counts.exceptions === 1 && counts.fatal_errors === 1,
          "Apex log parser did not recover the known debug/exception/fatal evidence.",
        );
        return result;
      });
      await run("lwc.valid.file.diagnose", "sf-lwc", async () => {
        const result = await requireSuccess("sf_lwc", {
          action: "file.diagnose",
          workspace,
          file: "force-app/main/default/lwc/smokeValid/smokeValid.html",
        });
        requireTrue(Array.isArray(details(result).diagnostics), "Missing LWC diagnostic array.");
        requireTrue(
          array(details(result).diagnostics).length === 0,
          `Expected valid LWC template to be clean: ${JSON.stringify(result)}`,
        );
        return result;
      });
      await run("lwc.invalid.file.diagnose", "sf-lwc", async () => {
        const result = await invoke("sf_lwc", {
          action: "file.diagnose",
          workspace,
          file: "force-app/main/default/lwc/smokeInvalid/smokeInvalid.html",
        });
        requireTrue(
          array(details(result).diagnostics).some((item) => record(item).severity === "error"),
          `Expected LWC compiler error: ${JSON.stringify(result)}`,
        );
        return result;
      });
      await run("flow.author.plan", "sf-flow", async () => {
        const result = await requireSuccess("sf_flow", {
          action: "author.plan",
          workspace,
          intent: "Create an autolaunched reusable helper flow that returns a constant message.",
          flow_type: "autolaunched",
        });
        requireTrue(
          typeof details(result).skeleton === "string" &&
            String(details(result).skeleton).includes("<Flow "),
          "Missing Flow authoring metadata skeleton.",
        );
        return result;
      });
      await run("flow.valid.diagnose.file", "sf-flow", async () => {
        const result = await requireSuccess("sf_flow", {
          action: "diagnose.file",
          workspace,
          file: "force-app/main/default/flows/SmokeValid.flow-meta.xml",
        });
        requireTrue(
          record(details(result).summary).high === 0,
          `Expected zero high findings in valid local Flow: ${JSON.stringify(result)}`,
        );
        return result;
      });
      await run("flow.invalid.diagnose.file", "sf-flow", async () => {
        const result = await invoke("sf_flow", {
          action: "diagnose.file",
          workspace,
          file: "force-app/main/default/flows/SmokeInvalid.flow-meta.xml",
        });
        requireTrue(
          Number(record(details(result).summary).high) > 0 &&
            Number(details(result).findings_total) > 0,
          `Expected high local Flow findings: ${JSON.stringify(result)}`,
        );
        return result;
      });
      await run("soql.valid.parser", "sf-soql", async () => {
        const parsed = parseSoql("SELECT Id, Name FROM Account WHERE Name = 'Smoke' LIMIT 2", {
          apiVersion: 67,
          context: "api",
        });
        requireTrue(
          !parsed.syntax_errors?.length &&
            parsed.primary_object === "Account" &&
            parsed.limit === 2,
          `Unexpected parsed SOQL shape: ${JSON.stringify(parsed)}`,
        );
        return parsed;
      });
      await run("soql.invalid.parser", "sf-soql", async () => {
        const parsed = parseSoql("SELECT FROM WHERE", { apiVersion: 67, context: "api" });
        requireTrue(
          (parsed.syntax_errors?.length ?? 0) > 0,
          `Expected parser syntax errors: ${JSON.stringify(parsed)}`,
        );
        return parsed;
      });
      await run("skills.native.load-gate-remove", "sf-skills", async () => {
        const sourceRoot = file("skill-smoke");
        const alpha = path.join(sourceRoot, "alpha", "SKILL.md");
        const beta = path.join(sourceRoot, "beta", "SKILL.md");
        for (const target of [alpha, beta]) await mkdir(path.dirname(target), { recursive: true });
        const skill = (name: string, manual = false) =>
          `---\nname: ${name}\ndescription: Local OMP skill integration smoke.\n${manual ? "disable-model-invocation: true\n" : ""}---\nUse this skill for offline Salesforce smoke checks.\n`;
        await writeFile(alpha, skill("sf-omp-smoke-alpha"));
        await writeFile(beta, skill("sf-omp-smoke-beta"));
        const agentDir = getAgentDir();
        await writeFile(
          path.join(agentDir, "config.yml"),
          "compaction:\n  enabled: false\nskills:\n  ignoredSkills: [never-*]\n",
        );
        async function nativeSkills(): Promise<{ names: string[]; hidden: string[] }> {
          const config = await Settings.loadReadOnly({ cwd: workspace, agentDir });
          const raw = config.getGlobalSettings();
          requireTrue(
            record(raw.compaction).enabled === false,
            "Skill changes erased unrelated native settings.",
          );
          const values = skillSettingsValues(raw);
          requireTrue(
            values.ignoredSkills.includes("never-*"),
            "Skill changes erased ignoredSkills.",
          );
          const skills = await rediscoverSkills({
            skills: [],
            refreshSkills: async () =>
              (
                await loadSkills({
                  cwd: workspace,
                  ...values,
                  enablePiUser: false,
                  enablePiProject: false,
                  enableClaudeUser: false,
                  enableClaudeProject: false,
                  enableAgentsUser: false,
                  enableAgentsProject: false,
                  enableCodexUser: false,
                })
              ).skills,
          });
          return {
            names: skills.map((entry) => entry.name),
            hidden: skills.filter((entry) => entry.hide).map((entry) => entry.name),
          };
        }
        updateSkillSources({ add: ["skill-smoke"], remove: [], scope: "global", cwd: workspace });
        const loaded = await nativeSkills();
        requireTrue(
          loaded.names.includes("sf-omp-smoke-alpha") && loaded.names.includes("sf-omp-smoke-beta"),
          "Native loader did not load the configured source.",
        );
        updateSkillSources({ add: [alpha], remove: [sourceRoot], scope: "global", cwd: workspace });
        const gated = await nativeSkills();
        requireTrue(
          gated.names.includes("sf-omp-smoke-alpha") && !gated.names.includes("sf-omp-smoke-beta"),
          "Per-file native skill projection loaded the disabled sibling.",
        );
        await writeFile(alpha, skill("sf-omp-smoke-alpha", true));
        const manual = await nativeSkills();
        requireTrue(
          manual.hidden.includes("sf-omp-smoke-alpha"),
          "Native loader did not honor manual-only skill invocation.",
        );
        updateSkillSources({ add: [], remove: [alpha], scope: "global", cwd: workspace });
        const removed = await nativeSkills();
        requireTrue(
          !removed.names.includes("sf-omp-smoke-alpha") &&
            !removed.names.includes("sf-omp-smoke-beta"),
          "Removed skills remain natively loaded.",
        );
        return { loaded, gated, manual, removed };
      });
      // Optional local server readiness is not confused with a clean Apex diagnosis.
      for (const [label, relative, expected] of [
        ["valid", "force-app/main/default/classes/SmokeValid.cls", "clean"],
        ["invalid", "force-app/main/default/classes/SmokeInvalid.cls", "error"],
      ] as const) {
        const name = `apex.${label}.diagnose.file`;
        try {
          const result = await invoke("sf_apex", { action: "diagnose.file", file: file(relative) });
          if (details(result).status === "unavailable") {
            checks.push({
              name,
              extension: "sf-apex",
              status: "blocked",
              reason: "Apex language-server prerequisite unavailable in isolated smoke state.",
              evidence: result,
            });
          } else {
            requireTrue(
              toolSucceeded(result) && details(result).status === expected,
              `Unexpected Apex diagnosis: ${JSON.stringify(result)}`,
            );
            checks.push({ name, extension: "sf-apex", status: "pass", evidence: result });
          }
        } catch (error) {
          checks.push({ name, extension: "sf-apex", status: "failed", reason: errorText(error) });
        }
      }
      const api: SmokeApi = {
        pi,
        ctx,
        workspace,
        file,
        run,
        skip: (name, extension, status, reason) => {
          checks.push({ name, extension, status, reason });
        },
        invoke,
        requireSuccess,
        requireTrue,
        details,
        handlers: (extension, event) => [...(hookHandlers.get(`${extension}\u0000${event}`) ?? [])],
        command: (name) => commands.get(name),
        runCommand: async (name, args, options = {}) => {
          const command = commands.get(name);
          requireTrue(command, `Expected registered command /${name}.`);
          const base = ctx as object;
          const sessionManager = record(Reflect.get(base, "sessionManager"));
          const getEntries = sessionManager.getEntries as () => unknown[];
          const before = Reflect.apply(getEntries, sessionManager, []).length;
          const notifications: CommandOutput["notifications"] = [];
          const ui = new Proxy(Reflect.get(base, "ui") as object, {
            get: (target, key) =>
              key === "notify"
                ? (message: string, level?: string) =>
                    notifications.push({ message: String(message), level: level ?? "info" })
                : Reflect.get(target, key),
          });
          const hasUI = options.hasUI ?? Reflect.get(base, "hasUI");
          const commandCtx = new Proxy(base, {
            get: (target, key) =>
              key === "hasUI" ? hasUI : key === "ui" ? ui : Reflect.get(target, key),
          });
          // Headless commands print their body (console.info/log) as in print mode.
          const stdout: string[] = [];
          const { info, log } = console;
          console.info = (...values: unknown[]) => stdout.push(values.map(String).join(" "));
          console.log = console.info;
          try {
            await command.handler(args, commandCtx);
          } finally {
            console.info = info;
            console.log = log;
          }
          const entries = Reflect.apply(getEntries, sessionManager, [])
            .slice(before)
            .map((entry) => ({
              customType: record(entry).customType as string | undefined,
              data: record(entry).data,
            }));
          const text = [
            ...notifications.map((entry) => entry.message),
            ...stdout,
            ...entries.map((entry) => {
              const data = record(entry.data);
              return typeof data.body === "string"
                ? `${String(data.title ?? "")}\n${data.body}`
                : JSON.stringify(entry.data ?? "");
            }),
          ].join("\n");
          return { notifications, stdout, entries, text };
        },
      };
      const modules = (await readdir(CHECKS_DIR).catch(() => []))
        .filter((name) => name.endsWith(".ts") && selected.includes(name.slice(0, -3)))
        .sort();
      for (const name of modules) {
        // Check modules are discovered from disk per packaged extension.
        const module: unknown = await import(path.join(CHECKS_DIR, name));
        const checksFor = record(module).default;
        if (typeof checksFor !== "function") {
          checks.push({
            name: `${name}.module`,
            extension: name.slice(0, -3),
            status: "failed",
            reason: "Check module has no default export function.",
          });
          continue;
        }
        await Reflect.apply(checksFor, undefined, [api]);
      }
      checks.push({
        name: "external.live.behavior",
        extension: "all",
        status: "not-tested",
        reason:
          "Requires explicit org/model credentials and live/external services; deliberately outside offline smoke.",
      });
    } catch (error) {
      checks.push({
        name: "smoke.runner",
        extension: "all",
        status: "failed",
        reason: errorText(error),
      });
    } finally {
      await persist();
      ctx.shutdown();
    }
  }
  pi.on("session_shutdown", async () => {
    sessionShutdown = true;
    await persist();
  });
}
