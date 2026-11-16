/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sf-mcp offline behavior in native OMP. The real sf_mcp tool plans and applies
 * reviewed entries into OMP's own MCP files (hermetic agent dir and the smoke
 * workspace's `.omp/mcp.json`); OMP's native MCP config loader then proves it
 * reads them with OMP semantics. Nothing connects: OMP only discovers MCP
 * servers at startup or on an explicit `/mcp reload`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { SmokeApi } from "../omp-smoke-extension.ts";

const EXTENSION = "sf-mcp";
const HEADLESS = "salesforce-headless-360";
const PUBLIC_CLIENT_ID = "omp-smoke-public-client";

type Entry = Record<string, unknown> & { oauth?: Record<string, unknown> };

function readEntry(file: string, name: string): Entry {
  const root = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, Entry> };
  const entry = root.mcpServers?.[name];
  if (!entry) throw new Error(`${name} is missing from ${file}.`);
  return entry;
}

/** Body of the human-only output entry a real command appended (never stdout in RPC). */
async function commandOutput(api: SmokeApi, action: () => Promise<unknown>): Promise<string> {
  const ctx = api.ctx as {
    sessionManager: { getBranch(): Array<{ type: string; customType?: string; data?: unknown }> };
  };
  const before = ctx.sessionManager.getBranch().length;
  await action();
  return ctx.sessionManager
    .getBranch()
    .slice(before)
    .filter((entry) => entry.type === "custom" && entry.customType === EXTENSION)
    .map((entry) => {
      const data = entry.data;
      return data && typeof data === "object" && "body" in data ? String(data.body) : "";
    })
    .join("\n");
}

export default async function mcpChecks(api: SmokeApi): Promise<void> {
  const { workspace } = api;
  const globalFile = path.join(getAgentDir(), "mcp.json");
  const projectFile = path.join(workspace, ".omp", "mcp.json");

  /** Plan then apply through the real tool, exactly as the model would. */
  async function planAndApply(
    plan: Record<string, unknown>,
    applyAction: string,
  ): Promise<{ planned: Record<string, unknown>; applied: Record<string, unknown> }> {
    const planned = api.details(await api.requireSuccess("sf_mcp", plan));
    api.requireTrue(
      planned.planId && planned.planHash,
      `No plan id/hash: ${JSON.stringify(planned)}`,
    );
    const applied = api.details(
      await api.requireSuccess("sf_mcp", {
        action: applyAction,
        scope: plan.scope,
        preset_id: plan.preset_id,
        plan_id: planned.planId,
        plan_hash: planned.planHash,
        allow_mutation: true,
      }),
    );
    return { planned, applied };
  }

  await api.run("mcp.tool.status.native-paths", EXTENSION, async () => {
    const global = await api.requireSuccess("sf_mcp", { action: "status" });
    const project = await api.requireSuccess("sf_mcp", { action: "status", scope: "project" });
    // OMP spells macOS /private/tmp paths as /tmp, so compare real locations.
    const nativeConfig = (result: unknown) => {
      const match = /Native config: (\S+?)(?:\\n|")/.exec(JSON.stringify(result));
      return match ? resolveEquivalentPath(match[1], { throughMissing: true }) : undefined;
    };
    const same = (file: string) => resolveEquivalentPath(file, { throughMissing: true });
    api.requireTrue(
      nativeConfig(global) === same(globalFile) && nativeConfig(project) === same(projectFile),
      `sf_mcp does not target OMP's native MCP files: ${JSON.stringify(global)} ${JSON.stringify(project)}`,
    );
    const presets = api.details(global).presets as Array<{ status: string }>;
    api.requireTrue(
      presets.length > 0 && presets.every((preset) => preset.status === "missing"),
      "Hermetic state should start with no configured preset.",
    );
    return { globalFile, projectFile, presets: presets.length };
  });

  await api.run("mcp.tool.mutation-requires-intent", EXTENSION, async () => {
    const result = await api.invoke("sf_mcp", {
      action: "configure.apply",
      scope: "project",
      preset_id: "trailhead",
      plan_id: "unknown",
      plan_hash: "unknown",
    });
    api.requireTrue(
      api.details(result).ok === false,
      `configure.apply without allow_mutation must fail closed: ${JSON.stringify(result)}`,
    );
    return api.details(result);
  });

  await api.run("mcp.configure.project.trailhead", EXTENSION, async () => {
    const { applied } = await planAndApply(
      { action: "configure.plan", scope: "project", preset_id: "trailhead", resolution: "enable" },
      "configure.apply",
    );
    const entry = readEntry(projectFile, "trailhead");
    api.requireTrue(
      entry.timeout === 120_000 && entry.url === "https://mcp.trailhead.salesforce.com/mcp",
      `Project entry is not in OMP's dialect (timeout in ms): ${JSON.stringify(entry)}`,
    );
    const status = api.details(
      await api.requireSuccess("sf_mcp", {
        action: "status",
        scope: "project",
        preset_id: "trailhead",
      }),
    );
    const [row] = status.presets as Array<{ status: string }>;
    api.requireTrue(row?.status === "managed-enabled", `Unexpected status ${JSON.stringify(row)}`);
    return { applied, entry: { url: entry.url, timeout: entry.timeout }, status: row.status };
  });

  await api.run("mcp.connection.global.headless-360", EXTENSION, async () => {
    await planAndApply(
      {
        action: "connection.plan",
        scope: "global",
        preset_id: "headless-360",
        environment: "sandbox",
        oauth_client_id: PUBLIC_CLIENT_ID,
      },
      "connection.apply",
    );
    const entry = readEntry(globalFile, HEADLESS);
    api.requireTrue(
      entry.timeout === 120_000 &&
        entry.oauth?.clientId === PUBLIC_CLIENT_ID &&
        typeof entry.oauth.redirectUri === "string" &&
        !("callbackUrl" in entry.oauth),
      `Global entry is not in OMP's OAuth dialect: ${JSON.stringify(entry)}`,
    );
    return { url: entry.url, timeout: entry.timeout, redirectUri: entry.oauth.redirectUri };
  });

  await api.run("mcp.omp.native-config-pickup", EXTENSION, async () => {
    // OMP caches config reads; /mcp reload clears the same cache before rediscovery.
    clearCache();
    const { configs, sources } = await loadAllMCPConfigs(workspace);
    const trailhead = configs.trailhead;
    const headless = configs[HEADLESS];
    api.requireTrue(
      trailhead?.type === "http" &&
        trailhead.url === "https://mcp.trailhead.salesforce.com/mcp" &&
        trailhead.timeout === 120_000 &&
        sources.trailhead?.level === "project" &&
        sources.trailhead.path === projectFile,
      `OMP did not load the project entry: ${JSON.stringify({ trailhead, source: sources.trailhead })}`,
    );
    api.requireTrue(
      headless?.type === "http" &&
        headless.timeout === 120_000 &&
        headless.oauth?.clientId === PUBLIC_CLIENT_ID &&
        typeof headless.oauth.redirectUri === "string" &&
        sources[HEADLESS]?.level === "user" &&
        sources[HEADLESS].path === globalFile,
      `OMP did not load the global entry: ${JSON.stringify({ headless, source: sources[HEADLESS] })}`,
    );
    return {
      trailhead: { type: trailhead.type, timeout: trailhead.timeout, source: sources.trailhead },
      [HEADLESS]: {
        type: headless.type,
        timeout: headless.timeout,
        redirectUri: headless.oauth?.redirectUri,
        source: sources[HEADLESS],
      },
    };
  });

  await api.run("mcp.login.handoff.omp-command", EXTENSION, async () => {
    const { applied: toolsApplied } = await planAndApply(
      {
        action: "tools.plan",
        scope: "global",
        preset_id: "headless-360",
        tool_profile: "recommended",
      },
      "tools.apply",
    );
    const handoff = api.details(
      await api.requireSuccess("sf_mcp", {
        action: "login.handoff",
        scope: "global",
        preset_id: "headless-360",
      }),
    );
    api.requireTrue(
      handoff.command === `/mcp reauth ${HEADLESS}` && Number(handoff.exposedTools) > 0,
      `Login handoff must name OMP's /mcp reauth: ${JSON.stringify(handoff)}`,
    );
    return { toolsApplied, handoff };
  });

  await api.run("mcp.identity.verify.no-delegation", EXTENSION, async () => {
    const result = await api.invoke("sf_mcp", {
      action: "identity.verify",
      scope: "global",
      preset_id: "headless-360",
    });
    // The singleton connection has no org binding, so this fails before any MCP call.
    api.requireTrue(
      api.details(result).ok === false &&
        JSON.stringify(result).includes("must be an enabled org-bound SF MCP connection"),
      `identity.verify must fail closed without an org binding: ${JSON.stringify(result)}`,
    );
    return api.details(result);
  });

  await api.run("mcp.routing.omp-prompt-block", EXTENSION, async () => {
    await planAndApply(
      {
        action: "configure.plan",
        scope: "project",
        preset_id: "salesforce-dx",
        resolution: "side-by-side",
      },
      "configure.apply",
    );
    const [sessionStart] = api.handlers(EXTENSION, "session_start");
    const [beforeAgentStart] = api.handlers(EXTENSION, "before_agent_start");
    api.requireTrue(sessionStart && beforeAgentStart, "sf-mcp prompt hooks are missing.");
    await sessionStart({ type: "session_start" }, api.ctx);
    const prepared = (await beforeAgentStart(
      { type: "before_agent_start", reason: "prompt", prompt: "smoke", systemPrompt: ["base"] },
      api.ctx,
    )) as { systemPrompt?: string[] } | undefined;
    const block = prepared?.systemPrompt?.[1] ?? "";
    api.requireTrue(
      prepared?.systemPrompt?.[0] === "base" &&
        block.startsWith("<sf_mcp_routing>\n- ") &&
        block.includes("MCP is enabled side-by-side with") &&
        block.endsWith("</sf_mcp_routing>"),
      `before_agent_start did not return OMP's systemPrompt array: ${JSON.stringify(prepared)}`,
    );
    return { sections: prepared.systemPrompt.length, block };
  });

  await api.run("mcp.disable.project.trailhead", EXTENSION, async () => {
    await planAndApply(
      { action: "disable.plan", scope: "project", preset_id: "trailhead" },
      "disable.apply",
    );
    clearCache();
    const { configs } = await loadAllMCPConfigs(workspace);
    // OMP suppresses disabled servers from the effective set, so it will not connect it.
    api.requireTrue(
      readEntry(projectFile, "trailhead").enabled === false &&
        (configs.trailhead === undefined || configs.trailhead.enabled === false),
      `OMP still treats trailhead as enabled after disable.apply: ${JSON.stringify(configs.trailhead)}`,
    );
    return { enabled: false };
  });

  await api.run("mcp.command.subcommands", EXTENSION, async () => {
    const command = api.command("sf-mcp");
    api.requireTrue(command?.extension === EXTENSION, "sf-mcp did not register /sf-mcp.");
    const run = (args: string) => commandOutput(api, () => command.handler(args, api.ctx));
    const status = await run("status --scope global");
    const conflicts = await run("conflicts salesforce-dx");
    const native = await run("native");
    const help = await run("help");
    api.requireTrue(
      status.includes(`Native config: ${globalFile}`) &&
        /headless-360\s+enabled/.test(status) &&
        conflicts.includes("Salesforce DX") &&
        native === "Run `/mcp list` in an interactive OMP session." &&
        help.includes("/sf-mcp conflicts <preset>"),
      `Unexpected /sf-mcp output: ${JSON.stringify({ status, conflicts, native, help })}`,
    );
    return { status, native };
  });

  api.skip(
    "mcp.exposure.live-tool-enforcement",
    EXTENSION,
    "not-tested",
    "No MCP server connects in smoke; hidden-tool deactivation and tool_call blocking need OMP-registered MCP tools (unit-tested with OMP ToolInfo shapes).",
  );
  api.skip(
    "mcp.live.oauth-and-org-binding",
    EXTENSION,
    "blocked",
    "OAuth login (/mcp reauth), org-pinned target_org discovery, and identity.verify need live Salesforce/MCP endpoints.",
  );
}
