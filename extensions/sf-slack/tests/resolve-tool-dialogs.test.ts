/* SPDX-License-Identifier: Apache-2.0 */
/** Registered Slack tool through OMP's native dialog controller and terminal widgets. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerResolveTool } from "../lib/resolve-tool.ts";
import type { ResolveResult, ResolvedChannel } from "../lib/types.ts";
import { createNativeTestUi, type NativeTestUi } from "./native-ui-fixture.ts";

vi.mock("../lib/auth.ts", () => ({ requireAuth: vi.fn(async () => ({ token: "test-token" })) }));
vi.mock("../lib/resolve.ts", () => ({
  resolveChannel: vi.fn(),
  resolveUser: vi.fn(),
  formatResolveResult: (result: unknown) => JSON.stringify(result),
}));
import { resolveChannel } from "../lib/resolve.ts";

function candidates(name: string): ResolveResult<ResolvedChannel> {
  const candidate = { id: `C_${name}_EXAMPLE`, name, confidence: 0.7, source: "test" };
  return {
    ok: true,
    input: name,
    type: "channel",
    best: candidate,
    candidates: [candidate],
    confidence: 0.7,
    strategy: [],
    warnings: [],
  };
}

function captureTool() {
  let execute: (...args: never[]) => Promise<{ details: ResolveResult<ResolvedChannel> }>;
  registerResolveTool({
    registerTool(definition: { execute: typeof execute }) {
      execute = definition.execute;
    },
  } as never);
  return (text: string, ui: unknown, options: { hasUI?: boolean; clarify?: boolean } = {}) =>
    execute(
      ...([
        `resolve-${text}`,
        { type: "channel", text, clarify: options.clarify },
        new AbortController().signal,
        undefined,
        { cwd: "/tmp/slack-dialog-proof", hasUI: options.hasUI ?? true, ui },
      ] as never[]),
    );
}

let harness: NativeTestUi;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(resolveChannel).mockImplementation(async (_token, text) => candidates(text));
  harness = await createNativeTestUi();
});

afterEach(() => {
  harness.dispose();
  vi.restoreAllMocks();
});

describe("slack_resolve native dialogs", () => {
  it("answers concurrent calls in native FIFO order without mixing their results", async () => {
    const { controller, ui, terminal, overlays, composer } = harness;
    const requested = vi.spyOn(controller, "showHookSelector");
    const run = captureTool();
    const first = run("first", ui);
    await vi.waitFor(() => expect(requested).toHaveBeenCalledTimes(1));
    const firstDialog = overlays.top();
    expect(firstDialog).toBeDefined();
    const second = run("second", ui);
    await vi.waitFor(() => expect(requested).toHaveBeenCalledTimes(2));
    expect(overlays.top()).toBe(firstDialog);
    terminal.press("enter");
    const result = (await first).details;
    expect(result).toMatchObject({ best: { name: "first" }, confidence: 1 });
    expect(result.warnings.join(" ")).not.toContain("Re-invoke serially");
    expect(overlays.top()).toBeDefined();
    expect(overlays.top()).not.toBe(firstDialog);
    terminal.press("enter");
    expect((await second).details).toMatchObject({ best: { name: "second" }, confidence: 1 });
    expect(overlays.open()).toBe(false);
    expect(terminal.surface.focused()).toBe(composer);
  });

  it("cancels one selector without stranding another", async () => {
    const { controller, ui, terminal, overlays } = harness;
    const requested = vi.spyOn(controller, "showHookSelector");
    const run = captureTool();
    const first = run("first", ui);
    await vi.waitFor(() => expect(requested).toHaveBeenCalledTimes(1));
    const second = run("second", ui);
    await vi.waitFor(() => expect(requested).toHaveBeenCalledTimes(2));
    terminal.press("escape");
    expect((await first).details.confidence).toBe(0.7);
    terminal.press("enter");
    expect((await second).details.confidence).toBe(1);
    expect(overlays.open()).toBe(false);
  });

  it("opens a queued selector after the exact-name input completes", async () => {
    vi.mocked(resolveChannel).mockImplementation(async (_token, text) =>
      text === "missing"
        ? { ...candidates(text), ok: false, best: undefined, candidates: [] }
        : { ...candidates(text), confidence: text === "exact" ? 1 : 0.7 },
    );
    const { controller, ui, terminal, overlays } = harness;
    const inputRequested = vi.spyOn(controller, "showHookInput");
    const selectorRequested = vi.spyOn(controller, "showHookSelector");
    const run = captureTool();
    const missing = run("missing", ui);
    await vi.waitFor(() => expect(inputRequested).toHaveBeenCalledTimes(1));
    const input = overlays.top();
    const first = run("first", ui);
    await vi.waitFor(() => expect(selectorRequested).toHaveBeenCalledTimes(1));
    expect(overlays.top()).toBe(input);
    terminal.type("exact");
    terminal.press("enter");
    expect((await missing).details).toMatchObject({ best: { name: "exact" }, confidence: 1 });
    terminal.press("enter");
    expect((await first).details).toMatchObject({ best: { name: "first" }, confidence: 1 });
    expect(overlays.open()).toBe(false);
  });

  it("opens the pending selector when an exact-name input is cancelled", async () => {
    vi.mocked(resolveChannel).mockImplementation(async (_token, text) =>
      text === "missing"
        ? { ...candidates(text), ok: false, best: undefined, candidates: [] }
        : candidates(text),
    );
    const { controller, ui, terminal, overlays } = harness;
    const inputRequested = vi.spyOn(controller, "showHookInput");
    const selectorRequested = vi.spyOn(controller, "showHookSelector");
    const run = captureTool();
    const missing = run("missing", ui);
    await vi.waitFor(() => expect(inputRequested).toHaveBeenCalledTimes(1));
    const first = run("first", ui);
    await vi.waitFor(() => expect(selectorRequested).toHaveBeenCalledTimes(1));
    terminal.press("escape");
    expect((await missing).details.ok).toBe(false);
    terminal.press("enter");
    expect((await first).details.confidence).toBe(1);
    expect(overlays.open()).toBe(false);
  });

  it("keeps high-confidence results non-interactive", async () => {
    vi.mocked(resolveChannel).mockResolvedValue({ ...candidates("exact"), confidence: 1 });
    const { ui, overlays } = harness;
    expect((await captureTool()("exact", ui)).details.confidence).toBe(1);
    expect(overlays.open()).toBe(false);
  });

  it.each([{ hasUI: false }, { clarify: false }])(
    "does not open dialogs for %j",
    async (options) => {
      const { ui, overlays } = harness;
      expect((await captureTool()("first", ui, options)).details.confidence).toBe(0.7);
      expect(overlays.open()).toBe(false);
    },
  );
});
