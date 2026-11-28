/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Funnel model and native row-view tests: counts, staging, and editable inputs.
 */
import type {
  ExtensionTheme,
  ExtensionUiHost,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { describe, expect, it, vi } from "vitest";
import type { SkillCatalog, CatalogSkill } from "../lib/catalog.ts";
import { SkillFunnelViewComponent } from "../lib/funnel-view/index.ts";
import {
  conflictRows,
  describePending,
  funnelCounts,
  skillGateRows,
  stageKey,
  tabCount,
} from "../lib/funnel-view/model.ts";
import type { FunnelAction } from "../lib/funnel-view/types.ts";

function skill(over: Partial<CatalogSkill> & { name: string; filePath: string }): CatalogSkill {
  return {
    description: undefined,
    sourceId: "s",
    sourceLabel: "s",
    sourceKind: "harness",
    autoDefault: false,
    seen: true,
    enabledGlobal: false,
    enabledProject: false,
    effective: "gated-out",
    conflictRole: "none",
    loadedByPi: false,
    ...over,
  };
}

const catalog: SkillCatalog = {
  skills: [
    skill({ name: "a", filePath: "/x/a", seen: true, enabledGlobal: true, effective: "loaded" }),
    skill({ name: "b", filePath: "/x/b", seen: true, enabledProject: true, effective: "loaded" }),
    skill({ name: "c", filePath: "/x/c", seen: true, effective: "gated-out" }),
    skill({ name: "d", filePath: "/y/d", seen: false, effective: "gated-out" }),
  ],
  conflicts: [{ name: "dup", kind: "resolvable", winner: undefined, losers: [], copies: [] }],
  sources: [
    {
      id: "s1",
      label: "s1",
      rootPath: "/x",
      kind: "harness",
      gate: "seen",
      autoDefault: false,
      counts: {
        total: 3,
        loaded: 2,
        shadowed: 0,
        gatedOut: 1,
        conflictWinners: 0,
        conflictLosers: 0,
      },
    },
  ],
};

describe("funnelCounts", () => {
  it("computes the narrowing strip", () => {
    expect(funnelCounts(catalog)).toEqual({
      catalog: 4,
      seen: 3,
      global: 1,
      project: 1,
      effective: 2,
      conflicts: 1,
    });
  });
});

describe("per-tab folds", () => {
  it("skill-gate tabs only show seen skills; catalog shows all", () => {
    expect(skillGateRows(catalog).map((s) => s.name)).toEqual(["a", "b", "c"]);
    expect(tabCount(catalog, "catalog")).toBe(4);
    expect(tabCount(catalog, "global")).toBe(3);
    expect(tabCount(catalog, "conflicts")).toBe(1);
    expect(conflictRows(catalog)).toHaveLength(1);
  });
});

describe("staging", () => {
  it("derives stable keys so toggling twice cancels", () => {
    const enable: FunnelAction = {
      kind: "skill-gate",
      name: "a",
      skillPath: "/x/a",
      scope: "global",
      enable: true,
    };
    const disable: FunnelAction = {
      kind: "skill-gate",
      name: "a",
      skillPath: "/x/a",
      scope: "global",
      enable: false,
    };
    // Same scope+path → same key regardless of enable direction (re-press cancels).
    expect(stageKey(enable)).toBe(stageKey(disable));
    // Different scope → different key.
    expect(stageKey({ ...enable, scope: "project" })).not.toBe(stageKey(enable));
  });

  it("summarizes pending actions", () => {
    const actions: FunnelAction[] = [
      { kind: "skill-gate", name: "a", skillPath: "/x/a", scope: "global", enable: true },
      { kind: "skill-gate", name: "b", skillPath: "/x/b", scope: "global", enable: true },
      { kind: "skill-gate", name: "c", skillPath: "/x/c", scope: "global", enable: false },
      { kind: "conflict-winner", name: "dup", winnerPath: "/x/dup" },
      { kind: "add-source", value: "~/work/s", scope: "global" },
    ];
    expect(describePending(actions)).toBe("+2 enable · 1 disable · 1 winner · 1 add");
    expect(describePending([])).toBe("no pending changes");
  });
});

describe("funnel editing", () => {
  const ui = { size: () => ({ columns: 90, rows: 24 }) } as ExtensionUiHost;
  const theme = { fg: (_color: string, text: string) => text } as ExtensionTheme;

  it("applies the selected skill after filtering", () => {
    const done = vi.fn();
    const panel = new SkillFunnelViewComponent(ui, theme, { catalog, cwd: "/x" }, done);
    for (const input of ["/", "c", "\r", "g", "\r"]) panel.handleInput(input);
    expect(done).toHaveBeenCalledWith({
      kind: "apply",
      actions: [
        { kind: "skill-gate", name: "c", skillPath: "/x/c", scope: "global", enable: true },
      ],
    });
    panel.dispose();
  });

  it("stages the edited custom source after bracketed paste", () => {
    const done = vi.fn();
    const panel = new SkillFunnelViewComponent(ui, theme, { catalog, cwd: "/x" }, done);
    for (const input of ["2", "a", "\x1b[200~/tmp/skillz\x1b[201~", "\x7f", "s", "\r", "\r"]) {
      panel.handleInput(input);
    }
    expect(done).toHaveBeenCalledWith({
      kind: "apply",
      actions: [{ kind: "add-source", value: "/tmp/skills", scope: "global" }],
    });
    panel.dispose();
  });
});
