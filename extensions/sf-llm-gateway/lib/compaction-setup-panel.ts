/* SPDX-License-Identifier: Apache-2.0 */
/** Focused dedicated-compaction setup shared by slash command and Manager action. */
import type { ExtensionTheme as Theme } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import { matchesKey, type RowsPanel } from "../../../lib/common/ui-rows.ts";
import { GatewayCompactionModelPicker } from "./compaction-model-picker.ts";
import type {
  CompactionSettingsScope,
  GatewayCompactionModel,
  GatewayCompactionModelOption,
} from "./compaction-settings.ts";

const MIN_CONTEXT_TOKENS = 1_000_000;
const MIN_OUTPUT_TOKENS = 8_192;

type PanelFocus = "model" | "save" | "cancel";

export interface GatewayCompactionSetupResult {
  configuredModel: Exclude<GatewayCompactionModel, "active">;
  needsReload?: boolean;
}

export function recommendGatewayCompactionModel(
  models: readonly GatewayCompactionModelOption[],
): GatewayCompactionModel | undefined {
  const eligible = models.filter(
    (model) =>
      (model.contextWindow ?? 0) >= MIN_CONTEXT_TOKENS &&
      (model.maxTokens ?? 0) >= MIN_OUTPUT_TOKENS,
  );
  return eligible.length === 1 ? eligible[0]?.value : undefined;
}

export class GatewayCompactionSetupComponent implements RowsPanel {
  private readonly picker: GatewayCompactionModelPicker;
  private readonly focusOrder: readonly PanelFocus[] = ["model", "save", "cancel"];
  private focusIndex = 0;
  private errorMessage: string | null = null;

  constructor(
    private readonly theme: Theme,
    scope: CompactionSettingsScope,
    cwd: string,
    private readonly done: (result: GatewayCompactionSetupResult | undefined) => void,
    models: readonly GatewayCompactionModelOption[],
    private readonly onSaved?: (model: GatewayCompactionSetupResult["configuredModel"]) => void,
    private readonly projectTrusted: boolean = true,
  ) {
    this.picker = new GatewayCompactionModelPicker(
      cwd,
      scope,
      models,
      recommendGatewayCompactionModel(models),
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.done(undefined);
      return;
    }

    const focus = this.currentFocus();
    if (focus === "model" && (matchesKey(data, "left") || matchesKey(data, "right"))) {
      this.errorMessage = null;
      this.picker.cycle(matchesKey(data, "left") ? -1 : 1);
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "down")) {
      this.errorMessage = null;
      this.focusIndex = (this.focusIndex + 1) % this.focusOrder.length;
      return;
    }
    if (matchesKey(data, "shift+tab") || matchesKey(data, "up")) {
      this.errorMessage = null;
      this.focusIndex = (this.focusIndex - 1 + this.focusOrder.length) % this.focusOrder.length;
      return;
    }
    if (!matchesKey(data, "enter")) return;

    if (focus === "cancel") {
      this.done(undefined);
      return;
    }
    if (focus === "model") {
      this.picker.cycle(1);
      return;
    }

    if (!this.projectTrusted) {
      this.errorMessage = "Project compaction settings require a trusted project.";
      return;
    }

    const configuredModel = this.picker.persistSetup();
    if (!configuredModel) {
      this.errorMessage =
        "Choose a cached Gateway model. Authenticate and refresh first when no model is listed.";
      return;
    }
    this.onSaved?.(configuredModel);
    this.done({ configuredModel });
  }

  renderContent(width: number): string[] {
    const lines = [
      this.theme.fg("muted", "Enable automatic compaction and use a dedicated Gateway model."),
      this.theme.fg(
        "dim",
        "This never changes the active chat model. Cached model metadata only; no network request.",
      ),
      "",
      ...this.picker.renderRows(this.theme, this.currentFocus() === "model"),
      "",
      `${this.renderButton("save", "Save")}  ${this.renderButton("cancel", "Cancel")}`,
    ];
    if (this.errorMessage) lines.push("", this.theme.fg("error", `⚠ ${this.errorMessage}`));
    lines.push("", this.theme.fg("dim", "←/→ choose · ↑/↓ move · Enter action · Esc cancel"));
    return lines.map((line) => truncate(line, width));
  }

  render(width: number): string[] {
    return this.renderContent(width);
  }

  private currentFocus(): PanelFocus {
    return this.focusOrder[this.focusIndex] ?? "model";
  }

  private renderButton(field: "save" | "cancel", label: string): string {
    const active = this.currentFocus() === field;
    return this.theme.fg(active ? "accent" : "muted", active ? `[ ${label} ]` : `  ${label}  `);
  }
}
