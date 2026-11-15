/* SPDX-License-Identifier: Apache-2.0 */
/** Smoke-only adapter: forwards real registrations and native hooks, then calls real tools. */
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { getAgentDir, getConfigRootDir } from "@oh-my-pi/pi-utils";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSkills,
  rediscoverSkills,
  Settings,
  type ExtensionAPI,
} from "@oh-my-pi/pi-coding-agent";
import { parseSoql } from "../extensions/sf-soql/lib/parser.ts";
import { updateSkillSources } from "../lib/common/skill-sources/skill-sources.ts";
import { skillSettingsValues } from "../lib/common/skill-sources/skill-settings.ts";
import { buildSkillInventory } from "../lib/common/skill-detection/detection.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selected = [
  "sf-guardrail",
  "sf-brain",
  "sf-apex",
  "sf-soql",
  "sf-lwc",
  "sf-code-analyzer",
  "sf-lsp",
  "sf-agentscript",
  "sf-skills",
  "sf-flow",
] as const;
type Status = "pass" | "failed" | "blocked" | "not-tested";
interface Check {
  name: string;
  extension: string;
  status: Status;
  evidence?: unknown;
  reason?: string;
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
          }
          return Reflect.apply(member, target, args);
        };
      },
    });
    try {
      // This runtime registry deliberately tests each plugin loading boundary independently.
      const module: unknown = await import(path.join(root, "extensions", name, "index.ts"));
      const factory = record(module).default;
      requireTrue(typeof factory === "function", `${name} has no extension factory.`);
      await Reflect.apply(factory, undefined, [proxy]);
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
        "Tool execute functions are invoked directly after registration: model tool selection, OMP tool-call approval/rendering and tool_call/tool_result dispatch are not exercised.",
        "No prompt or model request is submitted. Dummy OpenAI selection/key creates the host context only.",
        "No Salesforce org authentication, API calls, deploy/activate, Agentforce preview/eval, live schema grounding, Apex execution or tests are attempted.",
        "SOQL is the extension's actual parser called directly: the ordinary registered sf_soql tool connects to an org before dispatch.",
        "Apex diagnostics require an already provisioned repo-isolated language server; missing prerequisites are blocked, never installed here.",
        "Code Analyzer, managed LSP installation, managed skill downloads/catalog UI, brain projection and guardrail tool interception have startup coverage only.",
        "Outbound fetch is rejected in this child after smoke extension activation; this is not an OS-level network sandbox.",
      ],
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionStarted = true;
    async function run(
      name: string,
      extension: string,
      action: () => Promise<unknown>,
    ): Promise<void> {
      try {
        const evidence = await action();
        checks.push({ name, extension, status: "pass", evidence });
      } catch (error) {
        checks.push({ name, extension, status: "failed", reason: errorText(error) });
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
        const skillPath = file(".omp/skills/sf-omp-startup-smoke/SKILL.md");
        const command = pi
          .getCommands()
          .find((entry) => entry.source === "skill" && entry.path === skillPath);
        requireTrue(
          command,
          `Native OMP did not expose the startup skill path: ${JSON.stringify(pi.getCommands())}`,
        );
        const inventory = buildSkillInventory(pi.getCommands(), workspace);
        requireTrue(
          inventory.byFilePath.get(skillPath)?.commandName === command.name,
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
  });
  pi.on("session_shutdown", async () => {
    sessionShutdown = true;
    await persist();
  });
}
