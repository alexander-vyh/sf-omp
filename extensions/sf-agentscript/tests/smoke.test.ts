/* SPDX-License-Identifier: Apache-2.0 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  SF_PI_MANAGER_OPEN_EVENT,
  type SfPiManagerOpenRequest,
} from "../../../lib/common/manager-deep-link.ts";

function eventBus() {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  return {
    on(eventName: string, listener: (payload: unknown) => void) {
      listeners.set(eventName, [...(listeners.get(eventName) ?? []), listener]);
    },
    emit(eventName: string, payload: unknown) {
      for (const listener of listeners.get(eventName) ?? []) listener(payload);
    },
  };
}

function fakeCommandContext(): ExtensionCommandContext {
  return {
    hasUI: true,
    cwd: "/tmp/sf-pi-test",
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  } as unknown as ExtensionCommandContext;
}

describe("sf-agentscript", () => {
  it("returns full argument-tail values for nested report completions", async () => {
    const { getAgentScriptArgumentCompletions } = await import("../index.ts");

    expect(getAgentScriptArgumentCompletions("rep")?.map((item) => item.value)).toEqual([
      "report ",
    ]);
    expect(getAgentScriptArgumentCompletions("evals")?.map((item) => item.value)).toEqual([
      "evals",
    ]);
    expect(getAgentScriptArgumentCompletions("report ")?.map((item) => item.value)).toEqual([
      "report eval",
    ]);
    expect(getAgentScriptArgumentCompletions("report e")?.map((item) => item.value)).toEqual([
      "report eval",
    ]);
    expect(getAgentScriptArgumentCompletions("doctor help")).toBeNull();
  });

  it("routes the no-args UI command to the SF Pi Manager detail page", async () => {
    const mod = await import("../index.ts");
    const events = eventBus();
    const pi = {
      events,
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
    };
    let request: SfPiManagerOpenRequest | undefined;
    events.on(SF_PI_MANAGER_OPEN_EVENT, (payload) => {
      request = payload as SfPiManagerOpenRequest;
      request.accept?.();
      request.resolve?.();
    });

    mod.default(pi as never);
    const command = pi.registerCommand.mock.calls.find(([name]) => name === "sf-agentscript")?.[1];
    expect(command).toBeDefined();

    await command.handler("", fakeCommandContext());

    expect(request?.route?.extensionId).toBe("sf-agentscript");
    expect(request?.route?.view).toBe("detail");
  });
});
