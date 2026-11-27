/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Legacy preferences dialog for non-Manager fallback paths.
 *
 * Naming convention (sf-pi standard):
 *   - `lib/command-panel.ts`     — the no-args slash-command status & actions panel
 *   - `lib/config-panel.ts`      — ConfigPanelFactory invoked by sf-pi-manager
 *   - `lib/preferences-panel.ts` — legacy fallback preference editor (this file)
 *
 * Renders from the descriptor seam in preferences.ts. The primary mutable
 * surface is now `lib/config-panel.ts` in the SF Pi Manager Settings page.
 *
 * This module only owns the UI adapters; persistence is handled by the caller
 * so the extension can stay the single source of truth for `pi.appendEntry`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { signal, UiNode, type KeyEvent, type PasteEvent } from "@oh-my-pi/pi-tui";
import { resolveUiGlyphs, type UiGlyphs } from "../../../lib/common/ui-glyphs.ts";
import { nativeUi } from "../../../lib/common/ui-rows.ts";
import {
  SLACK_PREFERENCE_DESCRIPTORS,
  applyPreferenceValue,
  type SlackPreferenceKey,
  type SlackPreferenceSection,
  type SlackPreferences,
} from "./preferences.ts";

export interface PreferencesPanelOptions {
  /** Called when the user changes a row. The caller owns persistence. */
  onChange: (prefs: SlackPreferences) => void;
}

/** Opens the native settings picker and returns when dismissed. */
export async function openPreferencesPanel(
  ctx: ExtensionContext,
  current: SlackPreferences,
  options: PreferencesPanelOptions,
): Promise<void> {
  const working: SlackPreferences = { ...current };
  const glyphs = resolveUiGlyphs(ctx.cwd);

  if (!ctx.hasUI) {
    console.info(renderPreferencesSummary(working));
    return;
  }

  if (ctx.mode !== "tui") {
    await openPreferencesDialog(ctx, working, options);
    return;
  }

  await nativeUi(ctx.ui).custom<void>(
    (_ui, _theme, keybindings, done) => {
      const entries = SLACK_PREFERENCE_DESCRIPTORS.map((descriptor) => {
        const section = sectionLabel(descriptor.section);
        return {
          descriptor,
          label: `${sectionIcon(descriptor.section, glyphs)} ${section} · ${descriptor.label}`,
          searchable: `${section} ${descriptor.label} ${descriptor.description}`.toLowerCase(),
        };
      });
      const prefs = signal(working);
      const query = signal("");
      const initialOrder = entries.map(({ descriptor }) => descriptor.key);
      const order = signal(initialOrder);
      const selected = signal<string | undefined>(initialOrder[0]);

      function search(value: string): void {
        query.set(value);
        const needle = value.trim().toLowerCase();
        const matches = needle
          ? entries
              .filter((entry) => entry.searchable.includes(needle))
              .map(({ descriptor }) => descriptor.key)
          : initialOrder;
        order.set(matches);
        const id = selected.peek();
        if (!matches.some((match) => match === id)) selected.set(matches[0]);
      }

      function cycle(id: string | undefined, step: -1 | 1): void {
        const descriptor = entries.find((entry) => entry.descriptor.key === id)?.descriptor;
        if (!descriptor) return;
        const values: readonly SlackPreferences[SlackPreferenceKey][] = descriptor.values;
        const index = values.indexOf(prefs.peek()[descriptor.key]);
        const value = values[(index + step + values.length) % values.length];
        if (value === undefined) return;
        const next = applyPreferenceValue(prefs.peek(), descriptor.key, value);
        if (!next) return;
        prefs.set(next);
        options.onChange({ ...next });
      }

      return new UiNode("picker", {
        title: "💬 SF Slack Settings",
        query,
        order,
        selected,
        items: () =>
          entries.map(({ descriptor, label }) => ({
            id: descriptor.key,
            label,
            detail: `${prefs()[descriptor.key]} · ${descriptor.description}`,
          })),
        actions: [{ id: "close", label: "Close", keys: ["esc"] }],
        term: {
          head: [
            "Configure how Slack results are shown to the agent and in the UI.",
            `Sections: ${glyphs.status} Result detail · ${glyphs.controls} UI feedback · ${glyphs.links} Links`,
          ],
          layout: "inline",
          hint: "↑↓ move · ←→/Enter change · type search · Esc close",
          hintWrap: true,
          empty: "No matching settings",
        },
        onSelect: (id: string) => selected.set(id),
        onActivate: (id: string) => cycle(id, 1),
        onAction: (id: string) => {
          if (id === "close") done();
        },
        onPaste: ({ text }: PasteEvent) => {
          search(query.peek() + text.replace(/\s+/g, " "));
          return true;
        },
        onKey: (key: KeyEvent) => {
          if (key.kind === "release") return false;
          if (keybindings.matches(key, "tui.select.cancel")) {
            done();
          } else if (key.id === "left" || key.id === "right") {
            cycle(selected.peek(), key.id === "left" ? -1 : 1);
          } else if (key.id === "backspace") {
            search([...query.peek()].slice(0, -1).join(""));
          } else if (key.text) {
            search(query.peek() + key.text);
          } else {
            return false;
          }
          return true;
        },
      });
    },
    { overlay: true },
  );
}

async function openPreferencesDialog(
  ctx: ExtensionContext,
  working: SlackPreferences,
  options: PreferencesPanelOptions,
): Promise<void> {
  while (true) {
    const entries = SLACK_PREFERENCE_DESCRIPTORS.map((descriptor, index) => ({
      descriptor,
      option: `${index + 1}. ${sectionLabel(descriptor.section)} · ${descriptor.label} — current: ${working[descriptor.key]}`,
    }));
    const doneOption = "Done";
    const selected = await ctx.ui.select("SF Slack Settings", [
      ...entries.map((entry) => entry.option),
      doneOption,
    ]);
    if (!selected || selected === doneOption) return;

    const entry = entries.find((candidate) => candidate.option === selected);
    if (!entry) return;

    const valueEntries = entry.descriptor.values.map((value) => {
      const stringValue = String(value);
      return {
        value: stringValue,
        option:
          stringValue === working[entry.descriptor.key] ? `${stringValue} (current)` : stringValue,
      };
    });
    const pickedValue = await ctx.ui.select(
      `${entry.descriptor.label}\n${entry.descriptor.description}`,
      valueEntries.map((candidate) => candidate.option),
    );
    const valueEntry = valueEntries.find((candidate) => candidate.option === pickedValue);
    if (!valueEntry) continue;

    const next = applyPreferenceValue(working, entry.descriptor.key, valueEntry.value);
    if (!next) continue;
    Object.assign(working, next);
    options.onChange({ ...working });
    ctx.ui.notify(`${entry.descriptor.label}: ${valueEntry.value}`, "info");
  }
}

function renderPreferencesSummary(prefs: SlackPreferences): string {
  return [
    "SF Slack settings require an interactive Pi UI or RPC UI client.",
    "Current preferences:",
    ...SLACK_PREFERENCE_DESCRIPTORS.map(
      (descriptor) => `- ${descriptor.label}: ${prefs[descriptor.key]}`,
    ),
  ].join("\n");
}

function sectionLabel(section: SlackPreferenceSection): string {
  switch (section) {
    case "result":
      return "Result detail";
    case "feedback":
      return "UI feedback";
    case "links":
      return "Links";
  }
}

function sectionIcon(section: SlackPreferenceSection, glyphs: UiGlyphs): string {
  switch (section) {
    case "result":
      return glyphs.status;
    case "feedback":
      return glyphs.controls;
    case "links":
      return glyphs.links;
  }
}

// Legacy alias kept for one release while callers migrate to openPreferencesPanel.
export const openSettingsPanel = openPreferencesPanel;
