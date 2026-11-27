/* SPDX-License-Identifier: Apache-2.0 */
/** The HUD uses the same passive widget lifecycle on startup and reload. */
import { describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

function buildExtension() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    getCommands: vi.fn(() => []),
  };
  return { handlers, pi };
}

function fakeUiCtx() {
  return {
    hasUI: true,
    mode: "tui",
    cwd: process.cwd(),
    sessionManager: { getBranch: () => [], getLeafId: () => null },
    ui: {
      setWidget: vi.fn(),
      notify: vi.fn(),
      setWorkingVisible: vi.fn(),
    },
  };
}

async function fire(
  handlers: Map<string, Handler[]>,
  event: string,
  payload: unknown,
  ctx: unknown,
) {
  for (const h of handlers.get(event) ?? []) await h(payload, ctx);
}

describe("sf-skills reload safety", () => {
  it("mounts the passive HUD widget synchronously on a normal startup", async () => {
    const { handlers, pi } = buildExtension();
    (await import("../index.ts")).default(pi as never);
    const ctx = fakeUiCtx();
    await fire(handlers, "session_start", { reason: "startup" }, ctx);
    expect(ctx.ui.setWidget).toHaveBeenCalledExactlyOnceWith(
      "sf-skills-hud",
      expect.any(Function),
      { placement: "aboveEditor" },
    );
  });

  it("mounts the passive HUD widget synchronously during a reload", async () => {
    const { handlers, pi } = buildExtension();
    (await import("../index.ts")).default(pi as never);
    const ctx = fakeUiCtx();
    await fire(handlers, "session_start", { reason: "reload" }, ctx);
    expect(ctx.ui.setWidget).toHaveBeenCalledExactlyOnceWith(
      "sf-skills-hud",
      expect.any(Function),
      { placement: "aboveEditor" },
    );
  });
});
