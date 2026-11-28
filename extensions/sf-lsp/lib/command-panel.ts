/* SPDX-License-Identifier: Apache-2.0 */
/** Rich `/sf-lsp` panel for doctor status, recent activity and actions. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionTheme } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { signal, UiNode, type KeyEvent } from "@oh-my-pi/pi-tui";
import { padTo, truncate } from "@oh-my-pi/pi-tui/text/width";
import { nativeUi } from "../../../lib/common/ui-rows.ts";
import {
  LANGUAGE_ORDER,
  formatDuration,
  formatRelativeAge,
  languageLongLabel,
  statusColor,
  type LspActivityStore,
} from "./activity.ts";
import type { LspDoctorStatus } from "./types.ts";

export type SfLspPanelAction =
  "refresh-doctor" | "toggle-verbose" | "shutdown-servers" | "lifecycle-toggle" | "close";

export interface SfLspPanelLifecycleOptions {
  /** When true, the panel renders a Disable / Enable this extension row. */
  show: boolean;
  /** Current enablement state — controls the action label. */
  enabled: boolean;
}

export interface SfLspPanelOptions {
  store: LspActivityStore;
  doctorStatuses: LspDoctorStatus[];
  verboseEnabled: boolean;
  lifecycle: SfLspPanelLifecycleOptions;
}

export async function openSfLspPanel(
  ctx: ExtensionCommandContext,
  options: SfLspPanelOptions,
): Promise<SfLspPanelAction | null> {
  const result = await nativeUi(ctx.ui).custom<SfLspPanelAction>(
    (_ui, theme, keybindings, done) => {
      const actionItems: { value: SfLspPanelAction; label: string; description: string }[] = [
        {
          value: "refresh-doctor",
          label: "Refresh doctor",
          description: "Re-probe Apex, LWC, and Agent Script LSP discovery",
        },
        {
          value: "toggle-verbose",
          label: options.verboseEnabled ? "Quiet transcript rows" : "Verbose transcript rows",
          description: "Verbose = emit a row for every check (not just errors/transitions)",
        },
        {
          value: "shutdown-servers",
          label: "Shut down LSP servers",
          description: "Kill all child LSP processes; they restart lazily",
        },
        ...(options.lifecycle.show
          ? [
              {
                value: "lifecycle-toggle" as const,
                label: options.lifecycle.enabled
                  ? "Disable this extension"
                  : "Enable this extension",
                description: options.lifecycle.enabled
                  ? "Add an exclusion for sf-lsp to your OMP config and restart OMP"
                  : "Remove the exclusion for sf-lsp from your OMP config and restart OMP",
              },
            ]
          : []),
        {
          value: "close",
          label: "Close",
          description: "Dismiss this panel",
        },
      ];

      const selected = signal<SfLspPanelAction>("refresh-doctor");
      const activate = (value: string) => {
        const action = actionItems.find((item) => item.value === value);
        if (action) done(action.value);
      };
      const heading = (text: string) => theme.fg("toolTitle", theme.bold(` ${text}`));
      return new UiNode("col", {
        gap: 1,
        onKey: (key: KeyEvent) => {
          if (keybindings.matches(key, "tui.select.cancel")) {
            done("close");
          } else if (keybindings.matches(key, "tui.select.confirm")) {
            done(selected.peek());
          } else {
            const step = keybindings.matches(key, "tui.select.up")
              ? -1
              : keybindings.matches(key, "tui.select.down")
                ? 1
                : 0;
            if (!step) return false;
            const index = actionItems.findIndex((item) => item.value === selected.peek());
            const action = actionItems[(index + step + actionItems.length) % actionItems.length];
            if (action) selected.set(action.value);
          }
          return true;
        },
        children: [
          new UiNode("ansi", {
            text: theme.fg("accent", theme.bold(" 🩻 SF LSP — status & controls")),
          }),
          new UiNode("ansi", {
            text: [heading("DOCTOR"), ...buildDoctorLines(options.doctorStatuses, theme)].join(
              "\n",
            ),
          }),
          new UiNode("ansi", {
            text: [heading("RECENT ACTIVITY"), ...buildRecentLines(options.store, theme)].join(
              "\n",
            ),
          }),
          new UiNode("col", {
            children: [
              new UiNode("ansi", { text: heading("ACTIONS") }),
              new UiNode("list", {
                selected,
                onSelect: (value: string) => {
                  const action = actionItems.find((item) => item.value === value);
                  if (action) selected.set(action.value);
                },
                onActivate: activate,
                children: actionItems.map(
                  ({ value, label, description }) =>
                    new UiNode("item", { key: value, label, detail: description }),
                ),
              }),
            ],
          }),
          new UiNode("ansi", { text: theme.fg("dim", " ↑↓ navigate • Enter select • Esc close") }),
        ],
      });
    },
    { overlay: true },
  );

  return result ?? null;
}

// -------------------------------------------------------------------------------------------------
// Line builders (pure, used for tests too)
// -------------------------------------------------------------------------------------------------

export function buildDoctorLines(statuses: LspDoctorStatus[], theme: ExtensionTheme): string[] {
  const byLanguage = new Map(statuses.map((s) => [s.language, s]));
  return LANGUAGE_ORDER.map((language) => {
    const status = byLanguage.get(language);
    const label = theme.fg("text", padTo(languageLongLabel(language), 14));
    if (!status) {
      return `${theme.fg("dim", "?")} ${label}${theme.fg("dim", "not probed yet")}`;
    }
    if (status.available) {
      const source = status.source ? ` (${status.source})` : "";
      return `${theme.fg("success", "✓")} ${label}${theme.fg("dim", `${status.detail}${source}`)}`;
    }
    return `${theme.fg("error", "✗")} ${label}${theme.fg("warning", clampLine(status.detail, 120))}`;
  });
}

export function buildRecentLines(store: LspActivityStore, theme: ExtensionTheme): string[] {
  if (store.recent.length === 0) {
    return [theme.fg("dim", "no checks yet this session")];
  }
  const now = Date.now();
  return store.recent.slice(0, 8).map((record) => {
    const color = statusColor(record.status);
    const lang = theme.fg("text", padTo(languageLongLabel(record.language), 14));
    const file = theme.fg("accent", padTo(record.fileName, 18));
    const badge = theme.fg(color, padTo(shortStatus(record.status), 6));
    const duration = theme.fg("dim", formatDuration(record.durationMs));
    const age = theme.fg("dim", formatRelativeAge(record.timestamp, now));
    const errors =
      record.status === "error" ? ` ${theme.fg("error", `${record.diagnosticCount} err`)}` : "";
    return `${lang}${file}${badge}${duration}  ${age}${errors}`;
  });
}

function shortStatus(status: string): string {
  switch (status) {
    case "clean":
    case "transition-clean":
      return "ok";
    case "error":
      return "err";
    case "unavailable":
      return "off";
    case "checking":
      return "…";
    default:
      return "—";
  }
}

function clampLine(value: string, max: number): string {
  return truncate(value.replace(/\s+/g, " ").trim(), max);
}
