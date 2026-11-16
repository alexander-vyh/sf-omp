/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sf-mcp behavior contract
 *
 * SF MCP is a catalog and conflict-aware installer for Pi's native MCP runtime.
 * It never connects an MCP server itself; its model tool only plans and writes
 * reviewed native configuration while Pi continues to own transport and OAuth.
 *
 * Behavior matrix:
 *
 *   Trigger                    | Result
 *   ---------------------------|-----------------------------------------------------------
 *   extension load             | Register command and Manager actions; no network/process
 *   session_start              | Cache routing guidance; deactivate policy-hidden MCP tools (OMP)
 *   before_agent_start         | Add guidance only for accepted active overlaps; re-hide (OMP)
 *   tool_call                  | Block an MCP tool whose native policy is hidden (OMP)
 *   /sf-mcp                    | Open the SF Pi Manager detail page
 *   Manager Settings           | Show the preset catalog and explicit setup workflow
 *   /sf-mcp status             | Print native-config and overlap status
 *   /sf-mcp conflicts <preset> | Explain deterministic capability overlaps
 *   /sf-mcp disable <preset>   | Disable only an unchanged SF MCP-managed native entry
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getFirstTokenCompletionsFromActions,
  resolveAction,
  type SfPiCommandAction,
} from "../../lib/common/command-actions.ts";
import {
  emitHumanOnlyCommandOutput,
  registerHumanOnlyCommandOutput,
} from "../../lib/common/human-only-command-output.ts";
import { openInfoPanel } from "../../lib/common/info-panel.ts";
import {
  openExtensionInManager,
  type SfPiManagerOpenRoute,
} from "../../lib/common/manager-deep-link.ts";
import {
  registerManagerDetailActions,
  type ManagerDetailAction,
} from "../../lib/common/manager-actions.ts";
import { isOmpHost, requirePiVersion } from "../../lib/common/pi-compat.ts";
import { withSafeCommandHandler } from "../../lib/common/safe-command-handler.ts";
import { formatConflictPlan } from "./lib/conflict-planner.ts";
import { mcpConfigPath, setNativeMcpDialect } from "./lib/mcp-config.ts";
import { deactivateHiddenMcpTools, hiddenMcpToolNames } from "./lib/native-exposure.ts";
import { captureObservedMcpTools } from "./lib/observed-tools.ts";
import { SALESFORCE_MCP_PRESETS, getPreset } from "./lib/presets.ts";
import { registerSfMcpTool } from "./lib/sf-mcp-tool.ts";
import {
  buildMcpRoutingGuidelines,
  inspectPresetInstances,
  inspectPresetRuntime,
  setManagedPresetEnabled,
} from "./lib/service.ts";

const EXTENSION_ID = "sf-mcp";
const COMMAND_NAME = "sf-mcp";
const ROUTING_SECTION = "sf_mcp_routing";
type SfMcpAction = "status" | "catalog" | "conflicts" | "disable" | "native" | "help";

/** Replace SF MCP's own block on every preparation; other policy blocks stay untouched. */
function withMcpRoutingBlock(systemPrompt: readonly unknown[], guidelines: string[]): string[] {
  const open = `<${ROUTING_SECTION}>`;
  const close = `</${ROUTING_SECTION}>`;
  const sections = systemPrompt.filter(
    (section): section is string =>
      typeof section === "string" && !(section.startsWith(open) && section.endsWith(close)),
  );
  if (guidelines.length > 0) {
    sections.push([open, ...guidelines.map((line) => `- ${line}`), close].join("\n"));
  }
  return sections;
}

const ACTIONS: SfPiCommandAction<SfMcpAction>[] = [
  {
    value: "status",
    label: "Show MCP preset status",
    description: "Show managed, manual, disabled, and conflict states without connecting servers.",
    group: "Status",
  },
  {
    value: "catalog",
    label: "Open Salesforce MCP catalog",
    description: "Review conflicts and explicitly configure Salesforce-published MCP presets.",
    group: "Configure",
  },
  {
    value: "conflicts",
    label: "Review capability conflicts",
    description: "Explain overlaps between one MCP preset and enabled SF Pi family tools.",
    group: "Safety",
  },
  {
    value: "disable",
    label: "Disable a managed preset",
    description: "Persist enabled=false for one unchanged SF MCP-managed native entry.",
    group: "Configure",
  },
  {
    value: "native",
    label: "Open Pi native MCP manager",
    description: "Prepare /mcp for connection, OAuth, exposure, and error management.",
    group: "Native Pi",
  },
  {
    value: "help",
    label: "Show help",
    description: "Show SF MCP ownership, commands, and setup boundaries.",
    group: "Reference",
  },
];

export default function sfMcp(pi: ExtensionAPI): void {
  if (!requirePiVersion(pi, "sf-mcp")) return;

  setNativeMcpDialect(isOmpHost(pi) ? "omp" : "pi");
  registerSfMcpTool(pi);
  let routingGuidelines: string[] = [];
  pi.on("session_start", async (_event, ctx) => {
    captureObservedMcpTools(pi.getAllTools());
    routingGuidelines = buildMcpRoutingGuidelines(ctx.cwd);
    await deactivateHiddenMcpTools(pi, ctx.cwd);
  });
  // One registration serves both hosts: Pi passes mutable structured prompt
  // sections, OMP passes an ordered policy-block array and takes a replacement.
  const hostEvents = pi as unknown as {
    on(
      event: "before_agent_start",
      handler: (
        event: { systemPrompt: unknown; systemPromptOptions?: { promptGuidelines: string[] } },
        ctx: ExtensionContext,
      ) => Promise<{ systemPrompt: string[] } | undefined>,
    ): void;
  };
  hostEvents.on("before_agent_start", async (event, ctx) => {
    captureObservedMcpTools(pi.getAllTools());
    await deactivateHiddenMcpTools(pi, ctx.cwd);
    if (Array.isArray(event.systemPrompt)) {
      return { systemPrompt: withMcpRoutingBlock(event.systemPrompt, routingGuidelines) };
    }
    const promptGuidelines = event.systemPromptOptions?.promptGuidelines;
    if (!promptGuidelines) return undefined;
    for (const guideline of routingGuidelines) {
      if (!promptGuidelines.includes(guideline)) promptGuidelines.push(guideline);
    }
    return undefined;
  });
  pi.on("tool_call", (event, ctx) => {
    if (!event.toolName.startsWith("mcp__")) return undefined;
    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    if (!tool || !hiddenMcpToolNames(ctx.cwd, [tool]).has(event.toolName)) return undefined;
    return {
      block: true,
      reason: `${event.toolName} is hidden by its reviewed SF MCP tool policy. Review exposure with sf_mcp tools.plan instead of calling it.`,
    };
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Salesforce MCP preset catalog, conflict planning, and native Pi setup",
    getArgumentCompletions: (prefix) => getFirstTokenCompletionsFromActions(ACTIONS, prefix),
    handler: async (args, ctx) => {
      await withSafeCommandHandler(ctx, COMMAND_NAME, async () => {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0 && ctx.hasUI) {
          captureObservedMcpTools(pi.getAllTools());
          await openMcpInManager(pi, ctx, "detail");
          return;
        }
        const action = (resolveAction(ACTIONS, tokens[0] ?? "") ?? tokens[0] ?? "status") as string;
        await handleAction(pi, ctx, action, tokens.slice(1), false);
      });
    },
  });

  registerManagerDetailActions(pi, EXTENSION_ID, buildManagerActions(pi));
  registerHumanOnlyCommandOutput(pi, COMMAND_NAME);
}

function buildManagerActions(pi: ExtensionAPI): ManagerDetailAction[] {
  return ACTIONS.filter((action) => action.value !== "catalog" && action.value !== "disable").map(
    (action) => ({
      id: action.value,
      label: action.label,
      description: action.description,
      group: action.group,
      run: (ctx, scope) => handleAction(pi, ctx, action.value, ["--scope", scope], true),
    }),
  );
}

async function openMcpInManager(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  view: NonNullable<SfPiManagerOpenRoute["view"]>,
): Promise<void> {
  const opened = await openExtensionInManager(pi, ctx, {
    extensionId: EXTENSION_ID,
    view,
    actions: buildManagerActions(pi),
  });
  if (!opened) ctx.ui.notify("SF Pi Manager is unavailable. Try /sf-pi open sf-mcp.", "warning");
}

async function handleAction(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  action: string,
  args: string[],
  fromPanel: boolean,
): Promise<void> {
  captureObservedMcpTools(pi.getAllTools());
  const scope = parseScope(args);
  const positional = args.filter(
    (token, index) => token !== "--scope" && args[index - 1] !== "--scope",
  );

  if (action === "catalog") {
    if (ctx.hasUI) return openMcpInManager(pi, ctx, "settings");
    return emit(pi, ctx, "SF MCP catalog", renderStatus(ctx.cwd, scope), fromPanel);
  }
  if (action === "status") {
    return emit(pi, ctx, "SF MCP status", renderStatus(ctx.cwd, scope), fromPanel);
  }
  if (action === "conflicts") {
    let presetId = positional[0];
    if (!presetId && ctx.hasUI) {
      const selected = await ctx.ui.select(
        "Salesforce MCP preset",
        SALESFORCE_MCP_PRESETS.map((preset) => `${preset.id} — ${preset.label}`),
      );
      presetId = selected?.split(" — ")[0];
    }
    if (!presetId) {
      return emit(pi, ctx, "SF MCP conflicts", "Usage: /sf-mcp conflicts <preset-id>", fromPanel);
    }
    try {
      const state = inspectPresetRuntime(ctx.cwd, scope, getPreset(presetId));
      return emit(
        pi,
        ctx,
        `${state.preset.label} capability conflicts`,
        [
          `${state.preset.icon} ${state.preset.label}`,
          `Scope: ${scope}`,
          "",
          ...formatConflictPlan(state.plan),
        ].join("\n"),
        fromPanel,
      );
    } catch (error) {
      return emit(pi, ctx, "SF MCP conflicts", errorMessage(error), fromPanel);
    }
  }
  if (action === "disable") {
    if (scope === "project" && !ctx.isProjectTrusted()) {
      return emit(
        pi,
        ctx,
        "SF MCP disable",
        "Project MCP configuration is unavailable until Pi trusts this project. Use --scope global or /trust.",
        fromPanel,
      );
    }
    const presetId = positional[0];
    if (!presetId) {
      return emit(pi, ctx, "SF MCP disable", "Usage: /sf-mcp disable <preset-id>", fromPanel);
    }
    try {
      const result = setManagedPresetEnabled({
        cwd: ctx.cwd,
        scope,
        presetId: getPreset(presetId).id,
        connectionName: positional[1],
        enabled: false,
      });
      if (!result.ok) return emit(pi, ctx, "SF MCP disable", result.message, fromPanel);
      if (ctx.hasUI) {
        ctx.ui.notify(`${result.message} Reloading…`, "info");
        await ctx.reload();
        return;
      }
      await emit(pi, ctx, "SF MCP disable", result.message, fromPanel);
      return;
    } catch (error) {
      return emit(pi, ctx, "SF MCP disable", errorMessage(error), fromPanel);
    }
  }
  if (action === "native") {
    if (ctx.mode === "tui") {
      ctx.ui.setEditorText("/mcp");
      ctx.ui.notify("Prepared Pi's native /mcp manager in the editor.", "info");
      return;
    }
    return emit(
      pi,
      ctx,
      "Native MCP",
      isOmpHost(pi)
        ? "Run `/mcp list` in an interactive OMP session."
        : "Run `pi mcp list --json` outside a session.",
      fromPanel,
    );
  }
  return emit(pi, ctx, "SF MCP help", renderHelp(), fromPanel);
}

function renderStatus(cwd: string, scope: "global" | "project"): string {
  const rows = SALESFORCE_MCP_PRESETS.map((preset) => {
    const instances = inspectPresetInstances(cwd, scope, preset);
    const configured = instances.filter((instance) => instance.managed.status !== "missing");
    const state = configured[0] ?? instances[0] ?? inspectPresetRuntime(cwd, scope, preset);
    const status =
      configured.length > 1
        ? `${configured.length} connections`
        : statusLabel(state.managed.status);
    const overlap = state.plan.conflicts.length
      ? ` · overlaps ${state.plan.conflicts.map((item) => item.nativeExtensionId).join(", ")}`
      : "";
    const scopeConflict = state.scopeConflict ? ` · ${state.scopeConflict.kind}` : "";
    const drift =
      state.drift.status === "review"
        ? ` · tool review +${state.drift.added.length}/-${state.drift.removed.length}`
        : "";
    return `  ${preset.icon} ${preset.id.padEnd(22)} ${status}${overlap}${scopeConflict}${drift}`;
  });
  return [
    `Salesforce MCP presets — ${scope} scope`,
    `Native config: ${mcpConfigPath(cwd, scope)}`,
    "No preset connects until it is explicitly enabled.",
    "",
    ...rows,
  ].join("\n");
}

function renderHelp(): string {
  return [
    "SF MCP is a conflict-aware catalog for Pi's built-in MCP runtime.",
    "Its sf_mcp tool plans native configuration; Pi still owns transport, OAuth, connections, and tokens.",
    "",
    "Commands:",
    "  /sf-mcp                         Open SF MCP in the Manager",
    "  /sf-mcp catalog                 Open the interactive preset catalog",
    "  /sf-mcp status [--scope ...]    Show native configuration state",
    "  /sf-mcp conflicts <preset>      Explain capability overlaps",
    "  /sf-mcp disable <preset> [name] Disable one unchanged managed connection",
    "  /sf-mcp native                  Prepare Pi's native /mcp manager",
    "",
    "Use the catalog to enable presets. Existing entries require explicit adoption or diff-reviewed reset.",
  ].join("\n");
}

async function emit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  title: string,
  body: string,
  fromPanel: boolean,
): Promise<void> {
  if (ctx.hasUI && (fromPanel || body.includes("\n"))) {
    await openInfoPanel(ctx, { title, body, severity: "info" });
    return;
  }
  if (ctx.hasUI) {
    ctx.ui.notify(body, "info");
    return;
  }
  // Headless: stdout is the RPC/JSON channel outside print mode, so never console.info here.
  await emitHumanOnlyCommandOutput(pi, ctx, COMMAND_NAME, { title, body, severity: "info" });
}

function parseScope(args: string[]): "global" | "project" {
  const index = args.indexOf("--scope");
  return args[index + 1] === "global" ? "global" : "project";
}

function statusLabel(status: ReturnType<typeof inspectPresetRuntime>["managed"]["status"]): string {
  switch (status) {
    case "managed-enabled":
      return "enabled";
    case "managed-disabled":
      return "disabled";
    case "manual":
      return "manual config";
    case "modified":
      return "review changes";
    case "project-override":
      return "project override";
    case "managed-outdated":
      return "preset update";
    case "name-conflict":
      return "name conflict";
    case "invalid-config":
      return "invalid config";
    default:
      return "not configured";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
