/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Manager Settings panel for sf-slack.
 *
 * Shows connection status plus mutable Slack rendering preferences backed by
 * Pi settings under `sfPi.slack`.
 */
import type { ExtensionTheme } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { padTo } from "@oh-my-pi/pi-tui/text/width";
import { decodeRowKey, type RowsPanel } from "../../../lib/common/ui-rows.ts";
import type { ConfigPanelFactory, ConfigPanelResult } from "../../../catalog/registry.ts";
import { ENV_TOKEN, ENV_TEAM_ID } from "./types.ts";
import { type TokenSource, detectTokenSource, oauthScopes } from "./auth.ts";
import { getGrantedScopes } from "./api.ts";
import {
  SLACK_PREFERENCE_DESCRIPTORS,
  applyPreferenceValue,
  describeSlackPreferencesSource,
  readEffectiveSlackPreferences,
  readScopedSlackPreferences,
  setPreferences,
  writeScopedSlackPreferences,
  type SlackPreferenceScope,
  type SlackPreferences,
} from "./preferences.ts";

// ─── Panel component ────────────────────────────────────────────────────────────

class SlackConfigPanelComponent implements RowsPanel {
  focused = false;

  private cursor = 0;
  private draft: SlackPreferences;
  private saved: SlackPreferences;
  private savedSource: string;
  private message = "";

  constructor(
    private readonly theme: ExtensionTheme,
    private readonly cwd: string,
    private readonly scope: SlackPreferenceScope,
    private readonly done: (result: ConfigPanelResult | undefined) => void,
  ) {
    const scoped = readScopedSlackPreferences(cwd, scope);
    const effective = readEffectiveSlackPreferences(cwd);
    this.draft = scoped.exists ? { ...scoped.preferences } : { ...effective };
    this.saved = { ...this.draft };
    this.savedSource = scoped.exists ? scoped.path : describeSlackPreferencesSource(effective);
  }

  handleInput(data: string): void {
    const key = decodeRowKey(data);
    if (!key || key.kind === "release") return;
    switch (key.id) {
      case "escape":
      case "q":
        this.done(undefined);
        break;
      case "up":
        this.move(-1);
        break;
      case "down":
        this.move(1);
        break;
      case "left":
        this.cycle(-1);
        break;
      case "right":
      case "space":
        this.cycle(1);
        break;
      case "enter":
      case "s":
        this.save();
    }
  }

  renderContent(width: number): string[] {
    const lines: string[] = [];
    const t = this.theme;
    const pad = (content: string) => padTo(content, width);

    lines.push(...this.renderConnectionStatus(width));
    lines.push(pad(""));
    lines.push(pad(` ${t.fg("muted", "Slack Preferences")}`));
    lines.push(pad(`   ${t.fg("muted", "Scope:")} ${t.fg("text", this.scope)}`));
    lines.push(pad(`   ${t.fg("muted", "Current source:")} ${t.fg("dim", this.savedSource)}`));
    lines.push(
      pad(
        `   ${t.fg("muted", "Mode:")} ${t.fg("text", this.isDirty() ? "unsaved changes" : "saved")}`,
      ),
    );
    lines.push(pad(""));

    for (let i = 0; i < SLACK_PREFERENCE_DESCRIPTORS.length; i++) {
      const descriptor = SLACK_PREFERENCE_DESCRIPTORS[i];
      if (!descriptor) continue;
      const selected = i === this.cursor;
      const cursor = selected ? t.fg("accent", "→") : " ";
      const label = selected ? t.fg("accent", descriptor.label) : t.fg("text", descriptor.label);
      const value = String(this.draft[descriptor.key]);
      lines.push(pad(`   ${cursor} ${padTo(label, 26)} ${t.fg("muted", value)}`));
      if (selected) lines.push(pad(`      ${t.fg("dim", descriptor.description)}`));
    }

    lines.push(pad(""));
    if (this.message) lines.push(pad(` ${t.fg("success", this.message)}`));
    lines.push(pad(` ${t.fg("dim", "↑/↓ move · ←/→ change · S/Enter save · Esc back")}`));

    return lines;
  }

  render(width: number): string[] {
    return this.renderContent(width);
  }

  private renderConnectionStatus(width: number): string[] {
    const lines: string[] = [];
    const t = this.theme;
    const pad = (content: string) => padTo(content, width);
    const source = detectTokenSource();
    const teamId = process.env[ENV_TEAM_ID]?.trim() || "";

    lines.push(pad(` ${t.fg("muted", "SF Slack Connection Status")}`));
    lines.push(pad(""));

    if (source !== "none") {
      const sourceLabels: Record<TokenSource, string> = {
        env: `Environment (${ENV_TOKEN})`,
        "pi-auth": "Existing Pi auth credential",
        none: "Unknown",
      };
      lines.push(pad(` ${t.fg("success", "●")} ${t.fg("text", "Connected")}`));
      lines.push(
        pad(`   ${t.fg("muted", "Token source:")}  ${t.fg("text", sourceLabels[source])}`),
      );
      if (teamId) lines.push(pad(`   ${t.fg("muted", "Team ID:")}       ${t.fg("dim", teamId)}`));
      const granted = getGrantedScopes();
      const scopeLabel = granted ? "Granted:" : "Requested:";
      const scopeSource = granted
        ? [...granted]
        : oauthScopes()
            .split(",")
            .map((scope) => scope.trim());
      const scopeSummary = scopeSource.slice(0, 4).join(", ") + (scopeSource.length > 4 ? "…" : "");
      lines.push(pad(`   ${t.fg("muted", scopeLabel)}     ${t.fg("dim", scopeSummary)}`));
      return lines;
    }

    lines.push(pad(` ${t.fg("error", "●")} ${t.fg("text", "Not configured")}`));
    lines.push(
      pad(`   ${t.fg("warning", "Run /login sf-slack for masked credential setup in OMP.")}`),
    );
    lines.push(
      pad(
        `   ${t.fg("text", "Environment:")} ${t.fg("dim", `export ${ENV_TOKEN}=xoxp-... before starting Pi`)}`,
      ),
    );
    lines.push(pad(`   ${t.fg("dim", "Existing saved Pi credentials remain usable.")}`));
    return lines;
  }

  private move(delta: -1 | 1): void {
    this.cursor =
      (this.cursor + delta + SLACK_PREFERENCE_DESCRIPTORS.length) %
      SLACK_PREFERENCE_DESCRIPTORS.length;
    this.message = "";
  }

  private cycle(delta: -1 | 1): void {
    const descriptor = SLACK_PREFERENCE_DESCRIPTORS[this.cursor];
    if (!descriptor) return;
    const values = descriptor.values.map(String);
    const current = String(this.draft[descriptor.key]);
    const index = Math.max(0, values.indexOf(current));
    const next = values[(index + delta + values.length) % values.length];
    if (!next) return;
    const updated = applyPreferenceValue(this.draft, descriptor.key, next);
    if (!updated) return;
    this.draft = updated;
    this.message = "";
  }

  private save(): void {
    if (!this.isDirty()) {
      this.message = "No changes to save.";
      return;
    }
    const saved = writeScopedSlackPreferences(this.cwd, this.scope, this.draft);
    this.saved = { ...saved.preferences };
    this.savedSource = saved.path;
    setPreferences(saved.preferences);
    this.message = "Saved Slack preferences.";
  }

  private isDirty(): boolean {
    return JSON.stringify(this.saved) !== JSON.stringify(this.draft);
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────────

export const createConfigPanel: ConfigPanelFactory = (theme, cwd, scope, done) => {
  return new SlackConfigPanelComponent(theme, cwd, scope, done);
};
