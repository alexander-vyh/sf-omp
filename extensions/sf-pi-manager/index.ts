/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sf-pi-manager — Core manager extension for the sf-pi package.
 *
 * Provides:
 * - /sf-pi command with subcommands (list, enable, disable, status, etc.)
 * - Interactive TUI overlay for browsing, toggling, and inspecting extensions
 * - Footer status showing active extension count
 *
 * How enable/disable works: OMP-native `disabledExtensions`
 * ("extension-module:<id>") in OMP YAML config, applied by the
 * requirePiVersion gate on the next OMP start (lib/extension-enablement.ts).
 *
 * Commands:
 * - /sf-pi                    open interactive TUI overlay
 * - /sf-pi open <id> [settings] deep-link to an extension detail/settings page
 * - /sf-pi list               list extensions with enabled/disabled status
 * - /sf-pi enable <name>      enable a specific extension
 * - /sf-pi disable <name>     disable a specific extension
 * - /sf-pi enable-all         enable all extensions
 * - /sf-pi disable-all        disable all (except the manager)
 * - /sf-pi status             show summary
 * - /sf-pi display [profile]  show or set compact/balanced/verbose display profile
 * - /sf-pi recommended        list recommended packages and their OMP coverage
 * - /sf-pi announcements [...] list/dismiss/reset sf-pi announcements
 * - /sf-pi skills [...]       read-only skill-source summary (manage in /sf-skills)
 * - /sf-pi doctor [fix ...]   diagnose and repair startup/skill setup
 * - /sf-pi auto-update [...]  manage native auto-update
 * - /sf-pi help               show available commands
 *
 * Behavior matrix:
 *
 *   Trigger                      | Condition                   | Result
 *   -----------------------------|-----------------------------|-----------------------------------
 *   /sf-pi (no args)             | has UI                      | Open TUI overlay
 *   /sf-pi (no args)             | no UI                       | Fall back to list
 *   /sf-pi open <id> [settings]  | has UI                      | Open extension detail/settings page
 *   /sf-pi list                  | —                           | Show extension states
 *   /sf-pi enable <id>           | valid, currently disabled   | Remove disabled entry, ask for restart
 *   /sf-pi enable <id>           | valid, already enabled      | Notify "already enabled"
 *   /sf-pi enable <id>           | alwaysActive                | Notify "cannot toggle"
 *   /sf-pi disable <id>          | valid, currently enabled    | Add disabled entry, ask for restart
 *   /sf-pi disable-all           | —                           | Disable all non-alwaysActive, ask for restart
 *   /sf-pi enable-all            | —                           | Clear disabled entries, ask for restart
 *   /sf-pi display               | no profile                  | Show effective display profile
 *   /sf-pi display <profile>     | compact/balanced/verbose    | Save shared display profile
 *   TUI overlay → Enter          | list view                   | Open extension detail/config view
 *   TUI overlay → Esc            | list view, changes pending  | Write disabled entries, ask for restart
 *   TUI overlay → Esc            | detail view                 | Return to extension list
 *   session_start                | cadence due + interactive   | Record Auto Update as pending
 *   agent_start                  | update running              | Abort and defer remaining work
 *   agent_end (terminal)         | pending + idle + not aborted | Run one bounded update plan
 *   session_shutdown             | —                           | Cancel stale work; clear footer status
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SF_PI_REGISTRY } from "../../catalog/registry.ts";
import { nativeUi } from "../../lib/common/ui-rows.ts";
import {
  SfPiOverlayComponent,
  type ExtensionState,
  type OverlayInitialRoute,
  type OverlayResult,
} from "./lib/overlay.ts";
import {
  finishEnablementChange,
  resolveEnablementTarget,
  type EnablementTarget,
} from "./lib/extension-enablement.ts";
import { glyph, resolveGlyphMode } from "../../lib/common/glyph-policy.ts";
import { requirePiVersion } from "../../lib/common/pi-compat.ts";
import { resolveOmpConfigScope } from "../../lib/common/omp-extension-state.ts";
import { withSafeCommandHandler } from "../../lib/common/safe-command-handler.ts";
import {
  describeDisplaySettingsSource,
  readEffectiveSfPiDisplaySettings,
  writeScopedSfPiDisplaySettings,
} from "../../lib/common/display/settings.ts";
import { SF_PI_DISPLAY_PROFILES, isSfPiDisplayProfile } from "../../lib/common/display/types.ts";
import {
  completeArgumentTail,
  parseArgumentCompletionPrefix,
  type SfPiArgumentCompletion,
  type SfPiCompletionOption,
} from "../../lib/common/command-actions.ts";
import { handleRecommended, parseRecommendedArgs } from "./lib/recommendations.ts";
import {
  computeAnnouncementsNudge,
  handleAnnouncements,
  parseAnnouncementsArgs,
} from "./lib/announcements.ts";
import { handleSkills, parseSkillsArgs } from "./lib/skill-sources-command.ts";
import { handleDoctor, parseDoctorArgs } from "./lib/doctor-command.ts";
import {
  handleAutoUpdate,
  parseAutoUpdateArgs,
  type ManualAutoUpdateRunner,
} from "./lib/auto-update-command.ts";
import { createAgentSettledUpdateCoordinator } from "./lib/auto-update-coordinator.ts";
import { registerAutoUpdateTranscript } from "./lib/auto-update-transcript.ts";
import {
  runDoctorDiagnostics,
  summarizeStartupDoctorNudge,
} from "../../lib/common/doctor/diagnostics.ts";
import { loadAnnouncementsManifest } from "../../lib/common/catalog-state/announcements-manifest.ts";
import { buildAnnouncementsSync } from "../../lib/common/catalog-state/announcements-orchestrator.ts";
import { readAnnouncementsState } from "../../lib/common/catalog-state/announcements-state.ts";
import {
  collectManagerDetailActions,
  type ManagerDetailAction,
} from "../../lib/common/manager-actions.ts";
import {
  SF_PI_MANAGER_OPEN_EVENT,
  type SfPiManagerOpenRequest,
} from "../../lib/common/manager-deep-link.ts";

// -------------------------------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------------------------------

const COMMAND_NAME = "sf-pi";
const STATUS_KEY = "sf-pi";
const ANNOUNCEMENTS_STATUS_KEY = "sf-pi-announce";
const DOCTOR_STATUS_KEY = "sf-pi-doctor";

const TOP_LEVEL_COMPLETIONS: readonly SfPiCompletionOption[] = [
  {
    value: "list",
    description: "List extensions with enabled and disabled status",
    appendSpace: true,
  },
  {
    value: "enable",
    description: "Enable a bundled extension (applies on the next OMP start)",
    appendSpace: true,
  },
  {
    value: "disable",
    description: "Disable a bundled extension (applies on the next OMP start)",
    appendSpace: true,
  },
  {
    value: "enable-all",
    description: "Enable all bundled extensions in the selected scope",
    appendSpace: true,
  },
  {
    value: "disable-all",
    description: "Disable all non-required bundled extensions",
    appendSpace: true,
  },
  {
    value: "status",
    description: "Show sf-pi package, display, and extension status",
    appendSpace: true,
  },
  { value: "open", description: "Open an extension detail or settings page", appendSpace: true },
  {
    value: "display",
    description: "Show or set the shared sf-pi display profile",
    appendSpace: true,
  },
  { value: "recommended", description: "List recommended packages and their OMP coverage" },
  { value: "announcements", description: "List or acknowledge sf-pi announcements" },
  { value: "skills", description: "Show skill-source wiring diagnostics" },
  { value: "doctor", description: "Diagnose and repair sf-pi startup or skill setup" },
  { value: "auto-update", description: "Manage opt-in Native Auto Update", appendSpace: true },
  { value: "help", description: "Show the sf-pi command reference" },
];

const AUTO_UPDATE_COMPLETIONS: readonly SfPiCompletionOption[] = [
  { value: "status", description: "Show Native Auto Update status" },
  { value: "on", description: "Enable daily Native Auto Update" },
  { value: "off", description: "Disable Native Auto Update" },
  { value: "run", description: "Run Native Auto Update now" },
];

const OPEN_VIEW_COMPLETIONS: readonly SfPiCompletionOption[] = [
  { value: "detail", description: "Open the extension detail page" },
  { value: "settings", description: "Open the extension settings page" },
];

const SCOPE_COMPLETIONS: readonly SfPiCompletionOption[] = [
  { value: "global", description: "Use the global OMP config scope" },
  { value: "project", description: "Use the project OMP config scope" },
];

// -------------------------------------------------------------------------------------------------
// Package root detection
// -------------------------------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, "../..");

const PACKAGE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// -------------------------------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------------------------------

type CommandArgs = {
  subcommand:
    | "overlay"
    | "list"
    | "enable"
    | "disable"
    | "enable-all"
    | "disable-all"
    | "status"
    | "display"
    | "recommended"
    | "announcements"
    | "skills"
    | "doctor"
    | "auto-update"
    | "help";
  /**
   * Explicit scope from the command tokens, or `undefined` to mean
   * "auto-detect at dispatch time". Auto-detect prefers project over
   * global when the project OMP config defines `disabledExtensions`,
   * so a project-scoped list works without typing `project` on every command.
   */
  scope: "global" | "project" | undefined;
  target?: string;
  route?: OverlayInitialRoute;
  /** Raw tail after the subcommand token, used by multi-arg subcommands. */
  rest?: string;
};

// -------------------------------------------------------------------------------------------------
// Extension entry point
// -------------------------------------------------------------------------------------------------

export default function sfPiManagerExtension(pi: ExtensionAPI) {
  if (!requirePiVersion(pi, "sf-pi-manager")) return;

  const autoUpdateCoordinator = createAgentSettledUpdateCoordinator(pi);
  registerAutoUpdateTranscript(pi);

  pi.events.on(SF_PI_MANAGER_OPEN_EVENT, (request: SfPiManagerOpenRequest) => {
    request.accept?.();
    const scope = resolveOmpConfigScope(request.ctx.cwd);
    void handleOverlay(pi, request.ctx, scope, request.route).then(request.resolve, request.reject);
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "SF Pi extension manager — browse, enable, and disable extensions",
    getArgumentCompletions: getSfPiArgumentCompletions,
    handler: async (args, ctx) => {
      await withSafeCommandHandler(ctx, COMMAND_NAME, () =>
        handleCommand(pi, args, ctx, autoUpdateCoordinator),
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    updateFooterStatus(ctx);
    updateAnnouncementsNudge(ctx);
    updateDoctorNudge(ctx);
    autoUpdateCoordinator.onSessionStart(ctx);
  });

  pi.on("agent_start", () => {
    autoUpdateCoordinator.onAgentStart();
  });

  pi.on("agent_end", async (event, ctx) => {
    // OMP has no agent_settled. It marks non-terminal ends (retry, compaction,
    // queued follow-up, async wait) with willContinue; only a terminal end is
    // the settled boundary.
    const { willContinue, messages } = event as { willContinue?: boolean; messages?: unknown };
    if (willContinue === true) return;
    await autoUpdateCoordinator.onAgentSettled(ctx, endedAborted(messages));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    autoUpdateCoordinator.onSessionShutdown();
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setStatus(ANNOUNCEMENTS_STATUS_KEY, undefined);
    ctx.ui.setStatus(DOCTOR_STATUS_KEY, undefined);
    ctx.ui.setStatus("sf-pi-auto-update", undefined);
  });
}

/** A run ended aborted when its last assistant message stopped with `aborted`. */
function endedAborted(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; stopReason?: unknown } | null;
    if (message?.role === "assistant") return message.stopReason === "aborted";
  }
  return false;
}

// -------------------------------------------------------------------------------------------------
// Command routing
// -------------------------------------------------------------------------------------------------

// Exported for unit tests.
export function getSfPiArgumentCompletions(prefix: string): SfPiArgumentCompletion[] | null {
  const context = parseArgumentCompletionPrefix(prefix);

  // OMP passes the whole argument tail after `/sf-pi ` as the completion prefix,
  // then replaces that same tail when a completion is accepted. Nested
  // completions therefore return full argument-tail values such as
  // `auto-update status`, while keeping leaf labels such as `status` for a
  // compact completion menu.
  if (context.tokenIndex === 0) {
    return completeArgumentTail(TOP_LEVEL_COMPLETIONS, context);
  }

  const sub = context.tokens[0]?.toLowerCase();
  if (!sub) return null;

  if (
    (sub === "auto-update" || sub === "autoupdate" || sub === "update-auto") &&
    context.tokenIndex === 1
  ) {
    return completeArgumentTail(AUTO_UPDATE_COMPLETIONS, context);
  }

  if (sub === "display") {
    if (context.tokenIndex === 1) {
      return mergeCompletionResults(
        completeArgumentTail(displayProfileCompletions(), context),
        completeArgumentTail(SCOPE_COMPLETIONS, context),
      );
    }
    if (context.tokenIndex === 2) {
      return completeArgumentTail(SCOPE_COMPLETIONS, context);
    }
    return null;
  }

  if (sub === "enable" || sub === "disable") {
    if (context.tokenIndex === 1) {
      return completeArgumentTail(extensionCompletions({ includeAlwaysActive: false }), context);
    }
    if (context.tokenIndex === 2) {
      return completeArgumentTail(SCOPE_COMPLETIONS, context);
    }
    return null;
  }

  if (sub === "open") {
    if (context.tokenIndex === 1) {
      return completeArgumentTail(extensionCompletions({ includeAlwaysActive: true }), context);
    }
    if (context.tokenIndex === 2) {
      return completeArgumentTail(OPEN_VIEW_COMPLETIONS, context);
    }
    return null;
  }

  if (["list", "status", "enable-all", "disable-all"].includes(sub) && context.tokenIndex === 1) {
    return completeArgumentTail(SCOPE_COMPLETIONS, context);
  }

  return null;
}

function mergeCompletionResults(
  ...groups: (SfPiArgumentCompletion[] | null)[]
): SfPiArgumentCompletion[] | null {
  const merged = groups.flatMap((group) => group ?? []);
  return merged.length > 0 ? merged : null;
}

function displayProfileCompletions(): readonly SfPiCompletionOption[] {
  return SF_PI_DISPLAY_PROFILES.map((profile) => ({
    value: profile,
    description: `Set display profile to ${profile}`,
    appendSpace: true,
  }));
}

function extensionCompletions(options: {
  includeAlwaysActive: boolean;
}): readonly SfPiCompletionOption[] {
  return SF_PI_REGISTRY.filter(
    (extension) => options.includeAlwaysActive || !extension.alwaysActive,
  ).map((extension) => ({
    value: extension.id,
    description: extension.description,
    appendSpace: true,
  }));
}

// Exported for unit tests.
export function parseCommandArgs(raw: string): CommandArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();

  // Scope detection: last token can be "global" or "project". When
  // omitted we leave it undefined so the dispatcher can auto-detect from
  // where sf-pi is actually installed for this cwd.
  let scope: "global" | "project" | undefined;
  const lastToken = tokens[tokens.length - 1]?.toLowerCase();
  if (lastToken === "project" || lastToken === "global") {
    scope = lastToken as "global" | "project";
  }

  if (sub === "list" || sub === "ls") return { subcommand: "list", scope };
  if (sub === "status") return { subcommand: "status", scope };
  if (sub === "recommended" || sub === "recommend" || sub === "rec") {
    const rest = tokens.slice(1).join(" ");
    return { subcommand: "recommended", scope, rest };
  }
  if (sub === "announcements" || sub === "announce" || sub === "ann") {
    const rest = tokens.slice(1).join(" ");
    return { subcommand: "announcements", scope, rest };
  }
  if (sub === "skills" || sub === "skill") {
    const rest = tokens.slice(1).join(" ");
    return { subcommand: "skills", scope, rest };
  }
  if (sub === "doctor" || sub === "dr") {
    const rest = tokens.slice(1).join(" ");
    return { subcommand: "doctor", scope, rest };
  }
  if (sub === "auto-update" || sub === "autoupdate" || sub === "update-auto") {
    const rest = tokens.slice(1).join(" ");
    return { subcommand: "auto-update", scope, rest };
  }
  if (sub === "display") {
    const target =
      tokens[1] && tokens[1].toLowerCase() !== "global" && tokens[1].toLowerCase() !== "project"
        ? tokens[1].toLowerCase()
        : undefined;
    return { subcommand: "display", scope, target };
  }
  if (sub === "open") {
    const target =
      tokens[1] && tokens[1].toLowerCase() !== "global" && tokens[1].toLowerCase() !== "project"
        ? tokens[1]
        : undefined;
    const viewToken = tokens
      .find((token, index) => index > 1 && token !== "global" && token !== "project")
      ?.toLowerCase();
    const view = viewToken === "settings" ? "settings" : "detail";
    return { subcommand: "overlay", scope, target, route: { extensionId: target, view } };
  }
  if (sub === "help") return { subcommand: "help", scope };
  if (sub === "enable-all") return { subcommand: "enable-all", scope };
  if (sub === "disable-all") return { subcommand: "disable-all", scope };

  if (sub === "enable") {
    const target =
      tokens[1] && tokens[1].toLowerCase() !== "global" && tokens[1].toLowerCase() !== "project"
        ? tokens[1]
        : undefined;
    return { subcommand: "enable", scope, target };
  }

  if (sub === "disable") {
    const target =
      tokens[1] && tokens[1].toLowerCase() !== "global" && tokens[1].toLowerCase() !== "project"
        ? tokens[1]
        : undefined;
    return { subcommand: "disable", scope, target };
  }

  // No subcommand or unknown → open overlay
  if (!sub || sub === "manage") return { subcommand: "overlay", scope };

  return { subcommand: "help", scope };
}

// Exported for command-routing Behavior Proofs.
export async function handleCommand(
  pi: ExtensionAPI,
  raw: string,
  ctx: ExtensionCommandContext,
  autoUpdateRunner: ManualAutoUpdateRunner,
): Promise<void> {
  const args = parseCommandArgs(raw);
  // Resolve scope here so handlers always receive a concrete value but
  // parseCommandArgs stays pure (no fs access — keeps unit tests fast).
  const scope = args.scope ?? resolveOmpConfigScope(ctx.cwd);

  switch (args.subcommand) {
    case "overlay":
      await handleOverlay(pi, ctx, scope, args.route);
      break;
    case "list":
      await handleList(ctx, scope);
      break;
    case "enable":
      await handleToggle(ctx, scope, args.target, true);
      break;
    case "disable":
      await handleToggle(ctx, scope, args.target, false);
      break;
    case "enable-all":
      await handleToggleAll(ctx, scope, true);
      break;
    case "disable-all":
      await handleToggleAll(ctx, scope, false);
      break;
    case "status":
      await handleStatus(ctx, scope);
      break;
    case "display":
      handleDisplay(ctx, scope, args.target);
      break;
    case "recommended":
      handleRecommended(ctx, PACKAGE_ROOT, parseRecommendedArgs(args.rest ?? ""));
      break;
    case "announcements": {
      const annArgs = parseAnnouncementsArgs(args.rest ?? "");
      await handleAnnouncements(ctx, PACKAGE_ROOT, annArgs);
      // Listing an announcement counts as acknowledging the revision so the
      // footer nudge clears even if the user never dismisses the splash.
      updateAnnouncementsNudge(ctx);
      break;
    }
    case "skills": {
      const skillsArgs = parseSkillsArgs(args.rest ?? "");
      await handleSkills(ctx, skillsArgs);
      break;
    }
    case "doctor": {
      const doctorArgs = parseDoctorArgs(args.rest ?? "");
      const reloaded = await handleDoctor(ctx, doctorArgs);
      // ctx.reload() invalidates this command context. Treat it as terminal;
      // the replacement runtime's session_start hook refreshes the nudge.
      if (reloaded) return;
      updateDoctorNudge(ctx);
      break;
    }
    case "auto-update": {
      await handleAutoUpdate(pi, ctx, parseAutoUpdateArgs(args.rest ?? ""), autoUpdateRunner);
      break;
    }
    case "help":
      handleHelp(ctx);
      break;
  }
}

// -------------------------------------------------------------------------------------------------
// Command handlers
// -------------------------------------------------------------------------------------------------

async function handleOverlay(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  scope: "global" | "project",
  initialRoute?: OverlayInitialRoute,
): Promise<void> {
  if (ctx.mode !== "tui") {
    // Custom overlay components require a real terminal UI. RPC has
    // ctx.hasUI=true, so fall back to the text list outside TUI mode.
    await handleList(ctx, scope);
    return;
  }

  const target = resolveEnablementTarget(ctx.cwd, scope);

  const extensions = buildExtensionStates(target.disabledFiles);

  const result = await nativeUi(ctx.ui).custom<OverlayResult | undefined>(
    (ui, theme, _keybindings, done) =>
      new SfPiOverlayComponent(
        theme,
        PACKAGE_VERSION,
        PACKAGE_ROOT,
        ctx.cwd,
        extensions,
        SF_PI_REGISTRY,
        scope,
        done,
        ctx,
        ui,
        (extensionId) => collectOverlayActions(pi, extensionId, initialRoute),
        (action, scope) => action.run(ctx, scope),
        initialRoute,
      ),
    { overlay: true },
  );

  if (!result) {
    return;
  }

  if (result.runActionAfterClose) {
    const action = collectOverlayActions(
      pi,
      result.runActionAfterClose.extensionId,
      initialRoute,
    ).find((candidate) => candidate.id === result.runActionAfterClose?.actionId);
    if (action) await action.run(ctx, result.scope);
    return;
  }

  // Enablement applies on the next OMP start, in the scope the user may have
  // toggled in the overlay; a config-panel reload request still refreshes the
  // session.
  if (result.changed) {
    const effectiveTarget = resolveEnablementTarget(ctx.cwd, result.scope ?? scope);
    effectiveTarget.apply(result.disabledFiles);
    finishEnablementChange(ctx, effectiveTarget, "sf-pi extensions updated");
  }
  if (result.needsReload) await ctx.reload();
}

function collectOverlayActions(
  pi: ExtensionAPI,
  extensionId: string,
  initialRoute: OverlayInitialRoute | undefined,
): ManagerDetailAction[] {
  const direct =
    initialRoute?.extensionId === extensionId && initialRoute.actions ? initialRoute.actions : [];
  const discovered = collectManagerDetailActions(pi, extensionId);
  const byId = new Map<string, ManagerDetailAction>();
  for (const action of discovered) byId.set(action.id, action);
  for (const action of direct) byId.set(action.id, action);
  return [...byId.values()];
}

async function handleList(
  ctx: ExtensionCommandContext,
  scope: "global" | "project",
): Promise<void> {
  const target = resolveEnablementTarget(ctx.cwd, scope);
  const states = buildExtensionStates(target.disabledFiles);

  const enabledCount = states.filter((e) => e.enabled).length;
  const lines = [
    `sf-pi v${PACKAGE_VERSION} — ${enabledCount}/${states.length} extensions enabled`,
    `Settings scope: ${scope}`,
    "",
    ...states.map((ext) => {
      const icon = ext.alwaysActive ? "◆" : ext.enabled ? "●" : "○";
      const status = ext.alwaysActive ? "always" : ext.enabled ? "enabled" : "disabled";
      return `  ${icon} ${ext.name} [${ext.category}] — ${status}\n    ${ext.description}`;
    }),
  ];

  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleToggle(
  ctx: ExtensionCommandContext,
  scope: "global" | "project",
  target: string | undefined,
  enable: boolean,
): Promise<void> {
  if (!target) {
    ctx.ui.notify(
      `Usage: /${COMMAND_NAME} ${enable ? "enable" : "disable"} <extension-id>`,
      "warning",
    );
    return;
  }

  const ext = SF_PI_REGISTRY.find((e) => e.id === target || e.id === target.toLowerCase());

  if (!ext) {
    const available = SF_PI_REGISTRY.filter((e) => !e.alwaysActive)
      .map((e) => e.id)
      .join(", ");
    ctx.ui.notify(`Unknown extension: "${target}". Available: ${available}`, "warning");
    return;
  }

  if (ext.alwaysActive) {
    ctx.ui.notify(
      `${ext.name} is always active and cannot be ${enable ? "enabled" : "disabled"}.`,
      "warning",
    );
    return;
  }

  const enablement = resolveEnablementTarget(ctx.cwd, scope);

  const disabledFiles = enablement.disabledFiles;
  const wasEnabled = !disabledFiles.has(ext.file);

  if (enable && wasEnabled) {
    ctx.ui.notify(`${ext.name} is already enabled.`, "info");
    return;
  }

  if (!enable && !wasEnabled) {
    ctx.ui.notify(`${ext.name} is already disabled.`, "info");
    return;
  }

  if (enable) {
    disabledFiles.delete(ext.file);
  } else {
    disabledFiles.add(ext.file);
  }

  enablement.apply(disabledFiles);
  finishEnablementChange(ctx, enablement, `${ext.name} ${enable ? "enabled" : "disabled"}`);
  return;
}

async function handleToggleAll(
  ctx: ExtensionCommandContext,
  scope: "global" | "project",
  enable: boolean,
): Promise<void> {
  const enablement = resolveEnablementTarget(ctx.cwd, scope);

  const disabledFiles = new Set<string>();

  if (!enable) {
    // Disable all except alwaysActive
    for (const ext of SF_PI_REGISTRY) {
      if (!ext.alwaysActive) {
        disabledFiles.add(ext.file);
      }
    }
  }

  enablement.apply(disabledFiles);
  const action = enable ? "enabled" : "disabled";
  const count = enable
    ? SF_PI_REGISTRY.length
    : SF_PI_REGISTRY.filter((e) => !e.alwaysActive).length;
  finishEnablementChange(ctx, enablement, `${count} extension(s) ${action}`);
  return;
}

async function handleStatus(
  ctx: ExtensionCommandContext,
  scope: "global" | "project",
): Promise<void> {
  const target = resolveEnablementTarget(ctx.cwd, scope);
  const states = buildExtensionStates(target.disabledFiles);

  const enabledCount = states.filter((e) => e.enabled).length;
  const display = readEffectiveSfPiDisplaySettings(ctx.cwd);

  const lines = [
    "sf-pi Extension Suite",
    "",
    `Version: ${PACKAGE_VERSION}`,
    `Package root: ${PACKAGE_ROOT}`,
    `Extensions: ${enabledCount}/${states.length} enabled`,
    `Display profile: ${display.profile} (${describeDisplaySettingsSource(display)})`,
    `Settings scope: ${scope}`,
    ...enablementStatusLines(target),
    "",
    "Extensions:",
    ...states.map((ext) => {
      const icon = ext.alwaysActive ? "◆" : ext.enabled ? "●" : "○";
      const status = ext.alwaysActive ? "always" : ext.enabled ? "enabled" : "disabled";
      return `  ${icon} ${ext.id} (${status}) — ${ext.description}`;
    }),
    "",
    `Commands: /${COMMAND_NAME} help`,
  ].filter(Boolean);

  ctx.ui.notify(lines.join("\n"), "info");
}

function handleDisplay(
  ctx: ExtensionCommandContext,
  scope: "global" | "project",
  target: string | undefined,
): void {
  if (!target) {
    const display = readEffectiveSfPiDisplaySettings(ctx.cwd);
    ctx.ui.notify(
      [
        `sf-pi display profile: ${display.profile}`,
        `Source: ${describeDisplaySettingsSource(display)}`,
        "",
        "Profiles:",
        "  compact  — terse summaries and minimal previews",
        "  balanced — concise defaults with useful previews",
        "  verbose  — richer previews and fuller research detail",
        "",
        `Usage: /${COMMAND_NAME} display <compact|balanced|verbose> [global|project]`,
      ].join("\n"),
      "info",
    );
    return;
  }

  if (!isSfPiDisplayProfile(target)) {
    ctx.ui.notify(
      `Unknown display profile: ${target}. Use one of: ${SF_PI_DISPLAY_PROFILES.join(", ")}`,
      "warning",
    );
    return;
  }

  const saved = writeScopedSfPiDisplaySettings(ctx.cwd, scope, {
    profile: target,
  });
  ctx.ui.notify(
    `sf-pi display profile set to ${saved.settings.profile} in ${scope} settings.`,
    "info",
  );
}

function handleHelp(ctx: ExtensionCommandContext): void {
  const lines = [
    `sf-pi v${PACKAGE_VERSION} — Salesforce extension manager for OMP`,
    "",
    "Commands:",
    `  /${COMMAND_NAME}                          Open interactive TUI overlay`,
    `  /${COMMAND_NAME} open <id> [settings]      Open an extension detail/settings page`,
    `  /${COMMAND_NAME} list [global|project]     List extensions with status`,
    `  /${COMMAND_NAME} enable <id> [scope]       Enable an extension`,
    `  /${COMMAND_NAME} disable <id> [scope]      Disable an extension`,
    `  /${COMMAND_NAME} enable-all [scope]        Enable all extensions`,
    `  /${COMMAND_NAME} disable-all [scope]       Disable all (except manager)`,
    `  /${COMMAND_NAME} status [scope]            Show summary`,
    `  /${COMMAND_NAME} display [profile] [scope] Show or set display profile`,
    `  /${COMMAND_NAME} recommended               List recommended packages and their OMP coverage`,
    `  /${COMMAND_NAME} announcements [...]       List/dismiss/reset sf-pi announcements`,
    `  /${COMMAND_NAME} skills [...]              Skill-source summary (manage in /sf-skills)`,
    `  /${COMMAND_NAME} doctor [fix ...]          Diagnose and repair startup/skill setup`,
    `  /${COMMAND_NAME} auto-update [status|on|off|run] Manage native auto-update`,
    `  /${COMMAND_NAME} help                      Show this help`,
    "",
    "Available extensions:",
    ...SF_PI_REGISTRY.map(
      (ext) =>
        `  ${ext.id} [${ext.category}]${ext.alwaysActive ? " (always active)" : ""} — ${ext.description}`,
    ),
    "",
    "Scope defaults to project when the project OMP config defines disabledExtensions, otherwise global.",
    "Pass 'global' or 'project' as the last token to override.",
    "enable/disable writes OMP-native disabledExtensions and applies on the next OMP start.",
  ];

  ctx.ui.notify(lines.join("\n"), "info");
}

// -------------------------------------------------------------------------------------------------
// Footer status
// -------------------------------------------------------------------------------------------------

function updateFooterStatus(ctx: ExtensionContext): void {
  let disabled = new Set<string>();
  try {
    disabled = resolveEnablementTarget(ctx.cwd, resolveOmpConfigScope(ctx.cwd)).disabledFiles;
  } catch {
    // Footer status is best-effort; a malformed config must not break startup.
  }
  const states = buildExtensionStates(disabled);
  const enabledCount = states.filter((e) => e.enabled).length;
  // Glyph policy swaps `📦` for `[]` on terminals without emoji font
  // fallback so the bottom-bar status stays readable instead of tofu.
  const icon = glyph("loaded", resolveGlyphMode({ cwd: ctx.cwd }));
  ctx.ui.setStatus(
    STATUS_KEY,
    `${icon} SF Pi Packages: ${enabledCount}/${states.length} extensions`,
  );
}

function enablementStatusLines(target: EnablementTarget): string[] {
  return [
    "Host: OMP (extensions loaded by the sf-omp launcher)",
    `Enablement config: ${target.location} (disabledExtensions; restart OMP to apply)`,
  ];
}

// Footer nudge for unacknowledged announcements: one line, best-effort,
// cleared when the user acknowledges via splash dismiss or explicit
// `/sf-pi announcements`.
function updateAnnouncementsNudge(ctx: ExtensionContext): void {
  try {
    const manifest = loadAnnouncementsManifest(PACKAGE_ROOT);
    const state = readAnnouncementsState();
    const payload = buildAnnouncementsSync({ packageRoot: PACKAGE_ROOT, cwd: ctx.cwd });
    const nudge = computeAnnouncementsNudge(manifest, state, payload);
    if (!nudge.show) {
      ctx.ui.setStatus(ANNOUNCEMENTS_STATUS_KEY, undefined);
      return;
    }
    const icon = glyph("announce", resolveGlyphMode({ cwd: ctx.cwd }));
    ctx.ui.setStatus(
      ANNOUNCEMENTS_STATUS_KEY,
      `${icon} sf-pi: ${nudge.visibleCount} announcement(s) — /sf-pi announcements`,
    );
  } catch {
    ctx.ui.setStatus(ANNOUNCEMENTS_STATUS_KEY, undefined);
  }
}

// Footer nudge for actionable setup issues.
function updateDoctorNudge(ctx: ExtensionContext): void {
  try {
    const report = runDoctorDiagnostics({ cwd: ctx.cwd });
    const nudge = summarizeStartupDoctorNudge(report);
    if (!nudge || nudge.issueCount === 0) {
      ctx.ui.setStatus(DOCTOR_STATUS_KEY, undefined);
      return;
    }
    const icon = glyph("warn", resolveGlyphMode({ cwd: ctx.cwd }));
    ctx.ui.setStatus(DOCTOR_STATUS_KEY, `${icon} sf-pi doctor: ${nudge.message} — /sf-pi doctor`);
  } catch {
    ctx.ui.setStatus(DOCTOR_STATUS_KEY, undefined);
  }
}

// -------------------------------------------------------------------------------------------------
// Extension state helpers
// -------------------------------------------------------------------------------------------------

// Exported for unit tests.
export function buildExtensionStates(disabledFiles: Set<string>): ExtensionState[] {
  return SF_PI_REGISTRY.map((ext) => ({
    ...ext,
    enabled: ext.alwaysActive || !disabledFiles.has(ext.file),
  }));
}
