/* SPDX-License-Identifier: Apache-2.0 */
/** Invocation toggle overlay — split list + preview inside the SF Pi bordered pane. */
import type {
  ExtensionRows,
  ExtensionTheme,
  ExtensionUiHost,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { RowsTextField } from "../../../lib/common/ui-field.ts";
import { decodeRowKey } from "../../../lib/common/ui-rows.ts";
import { fitColumns, renderColumns, type ColumnSpec } from "./funnel-view/layout.ts";
import { modeForToggleSkill, packLabelFor, type ToggleSkill } from "./invocation/inventory.ts";
import {
  SKILL_PACKS,
  type SkillInvocationMode,
  type SkillInvocationPolicy,
} from "./invocation/types.ts";
import {
  TOGGLE_BODY_LINES,
  TOGGLE_CHROME,
  TOGGLE_INVOCATION_HEADER,
  TOGGLE_INVOCATION_MIN,
  TOGGLE_ORIGIN_HEADER,
  TOGGLE_ORIGIN_MIN,
  buildPreviewLines,
  splitTogglePane,
  type TogglePreviewSelection,
} from "./toggle-layout.ts";

export interface ToggleViewResult {
  action: "apply" | "cancel";
  policy: SkillInvocationPolicy;
}

export interface ToggleRow {
  kind: "pack" | "skill";
  id: string;
  name: string;
  origin: "Salesforce" | "Community";
  packId: string;
  packLabel: string;
  count?: number;
  mode: SkillInvocationMode | "mixed";
  locked: boolean;
  expanded?: boolean;
  description?: string;
  filePath?: string;
}

const COLUMNS: ColumnSpec[] = [
  { key: "cur", header: "", min: 1 },
  { key: "icon", header: "", min: 2 },
  { key: "name", header: "Name", min: 16, weight: 1 },
  { key: "origin", header: TOGGLE_ORIGIN_HEADER, min: TOGGLE_ORIGIN_MIN },
  { key: "count", header: "#", min: 3, align: "right" },
  { key: "state", header: TOGGLE_INVOCATION_HEADER, min: TOGGLE_INVOCATION_MIN },
];

const LAYOUT = { gap: 1, leftPad: 0, rightPad: 0 } as const;

const PACK_ICONS: Record<string, string> = {
  platform: "⚙",
  dx: "🚀",
  experience: "🖥",
  "ui-bundle": "📦",
  "design-systems": "🎨",
  agentforce: "✦",
  data360: "◉",
  omnistudio: "📑",
  automation: "⚡",
  integration: "🔌",
  commerce: "🛍",
  mobile: "📱",
  service: "🎧",
  sales: "💼",
  other: "•",
  community: "🧩",
};

export function buildToggleRows(
  skills: readonly ToggleSkill[],
  policy: SkillInvocationPolicy,
  expanded: ReadonlySet<string>,
  query: string,
): ToggleRow[] {
  const needle = query.trim().toLowerCase();
  if (needle) {
    return skills
      .filter((skill) =>
        `${skill.name} ${skill.description} ${skill.origin} ${skill.packLabel}`
          .toLowerCase()
          .includes(needle),
      )
      .map((skill) => skillRow(skill, policy));
  }

  const rows: ToggleRow[] = [];
  for (const pack of visiblePacks(skills)) {
    const members = skills.filter((skill) => skill.packId === pack.id);
    if (members.length === 0) continue;
    const modes = new Set(members.map((skill) => modeForToggleSkill(skill, policy)));
    const origin = pack.id === "community" ? "Community" : "Salesforce";
    rows.push({
      kind: "pack",
      id: pack.id,
      name: pack.label,
      origin,
      packId: pack.id,
      packLabel: pack.label,
      count: members.length,
      mode: singleMode(modes),
      locked: members.every((skill) => skill.authorDisabled || !skill.writable),
      expanded: expanded.has(pack.id),
    });
    if (!expanded.has(pack.id)) continue;
    for (const skill of members) rows.push(skillRow(skill, policy));
  }
  return rows;
}

export class SkillToggleViewComponent implements ExtensionRows {
  private readonly search: RowsTextField;
  private cursor = 0;
  private policy: SkillInvocationPolicy;
  private expanded = new Set<string>();

  constructor(
    private readonly ui: ExtensionUiHost,
    private readonly theme: ExtensionTheme,
    private readonly skills: ToggleSkill[],
    initial: SkillInvocationPolicy,
    private readonly done: (result: ToggleViewResult) => void,
  ) {
    this.search = new RowsTextField({
      placeholder: "(type to filter)",
      placeholderStyle: (text) => theme.fg("muted", text),
    });
    this.search.focused = true;
    this.policy = {
      default: initial.default,
      packs: { ...initial.packs },
      skills: { ...initial.skills },
    };
  }

  handleInput(data: string): void {
    const key = decodeRowKey(data);
    if (key?.kind === "release") return;
    switch (key?.id) {
      case "escape":
      case "ctrl+c":
        this.done({ action: "cancel", policy: this.policy });
        return;
      case "ctrl+s":
        this.done({ action: "apply", policy: this.policy });
        return;
      case "up":
        this.cursor = Math.max(0, this.cursor - 1);
        return;
      case "down":
        this.cursor = Math.min(Math.max(0, this.rows().length - 1), this.cursor + 1);
        return;
      case "left":
        this.setExpanded(false);
        return;
      case "right":
        this.setExpanded(true);
        return;
      case "space":
        this.toggleSelected();
        return;
    }
    const before = this.search.getValue();
    this.search.handleInput(data);
    if (this.search.getValue() !== before) this.cursor = 0;
  }

  render(width: number): string[] {
    const t = this.theme;
    if (width < 3) return [];
    const inner = Math.max(1, width - TOGGLE_CHROME);
    const terminalRows = this.ui.size().rows;
    const split = inner >= 69;
    const pane = split ? splitTogglePane(inner) : { left: inner, right: inner };
    const previewRows = split ? 0 : Math.min(6, Math.max(0, terminalRows - 14));
    const bodyLines = Math.min(TOGGLE_BODY_LINES, Math.max(1, terminalRows - 8 - previewRows));
    const rows = this.rows();
    const selected = rows[this.cursor];
    const start = Math.max(
      0,
      Math.min(this.cursor - Math.floor(bodyLines / 2), Math.max(0, rows.length - bodyLines)),
    );
    const slice = rows.slice(start, start + bodyLines);
    const widths = fitColumns(pane.left, COLUMNS, LAYOUT);
    const agentCount = this.skills.filter(
      (skill) => modeForToggleSkill(skill, this.policy) === "agent-invocable",
    ).length;
    const salesforce = this.skills.filter((skill) => skill.origin === "salesforce").length;
    const community = this.skills.length - salesforce;
    const approx = Math.ceil(
      this.skills
        .filter((skill) => modeForToggleSkill(skill, this.policy) === "agent-invocable")
        .reduce((sum, skill) => sum + skill.description.length, 0) / 4,
    );

    const searchLabel = t.fg("muted", "Search: ");
    const scopeCounts = t.fg("muted", `   SF ${salesforce}  ·  Community ${community}`);
    const searchWidth = inner - visibleWidth(searchLabel) - visibleWidth(scopeCounts);
    const searchLine = `${searchLabel}${this.search.render(Math.max(1, searchWidth))[0] ?? ""}${scopeCounts}`;
    const header = [
      t.fg("accent", t.bold("SF Skills Toggle")) +
        t.fg("dim", `   ${agentCount}/${this.skills.length} on  ·  ~${approx} tok`),
      searchLine,
      "",
    ];

    const tableHeader = t.fg(
      "toolTitle",
      renderColumns(
        COLUMNS.map((col) => ({ text: col.header, align: col.align })),
        widths,
        LAYOUT,
      ),
    );
    const leftBody = [tableHeader];
    if (slice.length === 0) leftBody.push(t.fg("dim", "No skills found."));
    for (const row of slice) leftBody.push(this.renderListRow(row, row === selected, widths));
    while (leftBody.length < bodyLines + 1) leftBody.push("");

    const preview = [
      t.fg("toolTitle", t.bold("Preview")),
      ...buildPreviewLines({
        width: pane.right,
        row: selected ? toPreviewSelection(selected) : undefined,
        members: selected?.kind === "pack" ? this.previewMembers(selected.id) : [],
      }).map((line, index) => this.colorPreviewLine(line, index, selected)),
    ];

    let body: string[];
    if (split) {
      const divider = t.fg("borderMuted", "│");
      body = leftBody.map(
        (line, i) =>
          `${truncate(line, pane.left, "…", true)} ${divider} ${truncate(preview[i] ?? "", pane.right, "…", true)}`,
      );
    } else {
      body = leftBody.concat(preview.slice(0, previewRows));
    }

    const rule = t.fg("borderAccent", "─".repeat(width));
    return [
      rule,
      ...[...header, ...body, "", formatHints(t)].map((line) => ` ${truncate(line, width - 2)} `),
      rule,
    ];
  }

  dispose(): void {
    this.search.dispose();
  }

  private rows(): ToggleRow[] {
    return buildToggleRows(this.skills, this.policy, this.expanded, this.search.getValue());
  }

  private renderListRow(row: ToggleRow, active: boolean, widths: number[]): string {
    const t = this.theme;
    const marker = active ? t.fg("accent", "→") : " ";
    const icon = row.kind === "pack" ? packIcon(row.packId) : " ";
    const fold = row.kind === "pack" ? (row.expanded ? "▾" : "▸") : " ";
    const label = row.kind === "pack" ? `${fold} ${t.bold(row.name)}` : `  ${row.name}`;
    const name = row.kind === "pack" ? t.fg("toolTitle", t.bold(label)) : t.fg("text", label);
    const origin = t.fg("dim", row.origin);
    const count = row.kind === "pack" ? t.fg("muted", String(row.count ?? "")) : "";
    const state = this.invocationLabel(row);
    return renderColumns(
      [
        { text: marker },
        { text: icon },
        { text: name },
        { text: origin },
        { text: count, align: "right" },
        { text: state },
      ],
      widths,
      LAYOUT,
    );
  }

  private invocationLabel(row: ToggleRow): string {
    const t = this.theme;
    if (row.locked) return t.fg("muted", "■ locked");
    if (row.mode === "agent-invocable") return t.fg("success", "✓ agent-invocable");
    if (row.mode === "mixed") return t.fg("warning", "◐ mixed");
    return t.fg("muted", "○ manual-only");
  }

  private colorPreviewLine(line: string, index: number, selected?: ToggleRow): string {
    const t = this.theme;
    if (!selected || !line) return line;
    if (index === 0) return t.fg("accent", t.bold(line));
    if (index === 2) {
      if (selected.locked) return t.fg("muted", line);
      if (selected.mode === "agent-invocable") return t.fg("success", line);
      if (selected.mode === "mixed") return t.fg("warning", line);
      return t.fg("dim", line);
    }
    if (line === "When to load" || line === "Pack" || line === "Members" || line === "Path") {
      return t.fg("toolTitle", t.bold(line));
    }
    return t.fg("text", line);
  }

  private previewMembers(packId: string) {
    return this.skills
      .filter((skill) => skill.packId === packId)
      .map((skill) => ({
        name: skill.name,
        on: modeForToggleSkill(skill, this.policy) === "agent-invocable",
        locked: skill.authorDisabled || !skill.writable,
      }));
  }

  private setExpanded(open: boolean): void {
    const row = this.rows()[this.cursor];
    if (!row) return;
    const packId = row.kind === "pack" ? row.id : row.packId;
    if (!packId) return;
    if (open) this.expanded.add(packId);
    else this.expanded.delete(packId);
    this.cursor = Math.max(
      0,
      this.rows().findIndex((candidate) => candidate.kind === "pack" && candidate.id === packId),
    );
  }

  private toggleSelected(): void {
    const row = this.rows()[this.cursor];
    if (!row || row.locked) return;
    const next: SkillInvocationMode =
      row.mode === "agent-invocable" ? "manual-only" : "agent-invocable";
    if (row.kind === "pack") {
      const skills = { ...this.policy.skills };
      const members = this.skills.filter((skill) => skill.packId === row.id);
      for (const skill of members) delete skills[skill.name];
      if (row.id === "community") {
        const nextSkills = { ...skills };
        for (const skill of members) nextSkills[skill.name] = next;
        this.policy = { ...this.policy, skills: nextSkills };
        return;
      }
      this.policy = {
        ...this.policy,
        packs: { ...this.policy.packs, [row.id]: next },
        skills,
      };
      return;
    }
    this.policy = {
      ...this.policy,
      skills: { ...this.policy.skills, [row.id]: next },
    };
  }
}

function skillRow(skill: ToggleSkill, policy: SkillInvocationPolicy): ToggleRow {
  return {
    kind: "skill",
    id: skill.name,
    name: skill.name,
    origin: skill.origin === "salesforce" ? "Salesforce" : "Community",
    packId: skill.packId,
    packLabel: skill.packLabel,
    mode: modeForToggleSkill(skill, policy),
    locked: skill.authorDisabled || !skill.writable,
    description: skill.description,
    filePath: skill.filePath,
  };
}

function visiblePacks(skills: readonly ToggleSkill[]): Array<{ id: string; label: string }> {
  const packs = SKILL_PACKS.filter((pack) => skills.some((skill) => skill.packId === pack.id)).map(
    (pack) => ({
      id: pack.id,
      label: pack.label,
    }),
  );
  if (skills.some((skill) => skill.packId === "community")) {
    packs.push({ id: "community", label: packLabelFor("community") });
  }
  return packs;
}

function packIcon(packId: string): string {
  return PACK_ICONS[packId] ?? "•";
}

function singleMode(modes: Set<SkillInvocationMode>): SkillInvocationMode | "mixed" {
  if (modes.size !== 1) return "mixed";
  for (const mode of modes) return mode;
  return "mixed";
}

function formatHints(theme: ExtensionTheme): string {
  const key = (value: string) => theme.fg("accent", theme.bold(value));
  const label = (value: string) => theme.fg("dim", value);
  const sep = theme.fg("borderMuted", " · ");
  return [
    `${key("↑↓")} ${label("move")}`,
    `${key("←→")} ${label("fold pack")}`,
    `${key("space")} ${label("toggle")}`,
    `${key("ctrl+s")} ${label("apply")}`,
    `${key("esc")} ${label("cancel")}`,
  ].join(sep);
}

function toPreviewSelection(row: ToggleRow): TogglePreviewSelection {
  return {
    kind: row.kind,
    id: row.id,
    packLabel: row.packLabel,
    origin: row.origin,
    mode: row.mode,
    locked: row.locked,
    description: row.description,
    filePath: row.filePath,
  };
}
