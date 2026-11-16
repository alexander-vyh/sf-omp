/* SPDX-License-Identifier: Apache-2.0 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SfEnvironment } from "../../../lib/common/sf-environment/types.ts";

// OMP ignores setFooter, so the DevBar must mount its bottom bar as a widget there.
vi.mock("../../../lib/common/pi-compat.ts", () => ({
  isOmpHost: () => true,
  requirePiVersion: () => true,
}));
vi.mock("../../../lib/common/sf-environment/shared-runtime.ts", () => ({
  bindPiForSessionPersistence: vi.fn(),
  restoreFromSessionEntries: vi.fn(),
  getCachedSfEnvironment: (): SfEnvironment => ({
    cli: { installed: true },
    project: { detected: true },
    config: { hasTargetOrg: true, targetOrg: "Example-Org", location: "Local" },
    org: { detected: true, orgType: "sandbox", alias: "Example-Org" },
    detectedAt: Date.now(),
  }),
  getSharedSfEnvironment: vi.fn(),
  refreshSharedSfEnvironment: vi.fn(),
}));
vi.mock("../../../lib/common/sf-environment/persisted-cache.ts", () => ({
  readPersistedSfEnvironment: () => null,
}));

import sfDevBar from "../index.ts";

type Component = { render(width: number): string[]; dispose?: () => void };

afterEach(() => {
  vi.useRealTimers();
});

describe("sf-devbar on the OMP host", () => {
  it("renders the bottom bar below the editor and reads the git branch itself", async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
    const tui = { requestRender: vi.fn() };
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const widgets = new Map<string, { component: Component; placement?: string }>();
    const ui = {
      setWidget: vi.fn((key: string, value: unknown, options?: { placement?: string }) => {
        widgets.get(key)?.component.dispose?.();
        widgets.delete(key);
        if (typeof value === "function") {
          widgets.set(key, {
            component: value(tui, theme) as Component,
            placement: options?.placement,
          });
        }
      }),
      setFooter: vi.fn(),
      setTitle: vi.fn(),
      notify: vi.fn(),
      setStatus: vi.fn(),
    };
    const cwd = "/workspace/sf-devbar-omp";
    const ctx = {
      cwd,
      hasUI: true,
      mode: "tui",
      model: { provider: "openai", id: "example-model", name: "Example Model" },
      sessionManager: SessionManager.inMemory(cwd),
      ui,
      getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 }),
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext;
    const exec = vi.fn(async (_command: string, args: string[]) => ({
      stdout: args[0] === "branch" ? "feature/omp\n" : " M index.ts\n",
      stderr: "",
      code: 0,
      killed: false,
    }));
    const pi = {
      events: new EventEmitter(),
      on(event: string, handler: (event: unknown, eventCtx: ExtensionContext) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerFlag: vi.fn(),
      getFlag: vi.fn(() => false),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      getThinkingLevel: vi.fn(() => "high"),
      getSessionName: vi.fn(() => undefined),
      exec,
      appendEntry: vi.fn(),
    } as unknown as ExtensionAPI;
    const emit = async (event: string, payload: unknown = { type: event }) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    };

    sfDevBar(pi);
    for (const event of ["model_select", "session_info_changed", "thinking_level_select"]) {
      expect(handlers.has(event)).toBe(false);
    }
    await emit("session_start");

    expect(ui.setFooter).not.toHaveBeenCalled();
    const footer = widgets.get("sf-devbar-footer");
    expect(footer?.placement).toBe("belowEditor");
    const bottom = footer?.component.render(160).join("\n") ?? "";
    expect(bottom).toContain("SFDX Project │ Default →");
    expect(bottom).toContain("Example-Org");

    await vi.advanceTimersByTimeAsync(1_500);
    expect(exec).toHaveBeenCalledWith("git", ["branch", "--show-current"], expect.anything());
    const top = widgets.get("sf-devbar")?.component.render(200).join("\n") ?? "";
    expect(top).toContain("feature/omp");
    expect(top).toContain("~1");
    // Git refresh repaints without remounting, so widget order stays stable.
    expect(ui.setWidget.mock.calls.filter(([key]) => key === "sf-devbar")).toHaveLength(1);

    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(widgets.size).toBe(0);
  });
});
