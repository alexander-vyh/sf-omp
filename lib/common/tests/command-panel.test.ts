/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Unit tests for command-panel close, selection and action lifecycle behavior.
 */
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import type {
  ExtensionCustomFactory,
  ExtensionRows,
  ExtensionTheme,
  ExtensionUiHost,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { describe, expect, it, vi } from "vitest";
import { matchesCloseKeyword, openCommandPanel, type CommandPanelState } from "../command-panel.ts";
import { isLifecycleToggleAction } from "../extension-toggle.ts";

describe("matchesCloseKeyword", () => {
  it("matches the exact `exit` keyword", () => {
    expect(matchesCloseKeyword("exit")).toBe(true);
  });

  it("matches the exact `quit` keyword", () => {
    expect(matchesCloseKeyword("quit")).toBe(true);
  });

  it("does not match partial keywords", () => {
    expect(matchesCloseKeyword("exi")).toBe(false);
    expect(matchesCloseKeyword("qui")).toBe(false);
  });

  it("is case-sensitive (callers normalize beforehand)", () => {
    // GroupedActionList lower-cases keystrokes before passing them in so the
    // match function itself stays simple. Document that contract here so a
    // refactor that drops the caller-side normalization breaks loudly.
    expect(matchesCloseKeyword("EXIT")).toBe(false);
    expect(matchesCloseKeyword("Quit")).toBe(false);
  });

  it("does not match unrelated text", () => {
    expect(matchesCloseKeyword("")).toBe(false);
    expect(matchesCloseKeyword("save")).toBe(false);
    expect(matchesCloseKeyword("exitnow")).toBe(false);
  });
});

describe("openCommandPanel", () => {
  it("uses dialog UI instead of custom components outside TUI mode", async () => {
    const onAction = vi.fn();
    const ctx = {
      mode: "rpc",
      hasUI: true,
      cwd: process.cwd(),
      ui: {
        custom: vi.fn(async () => {
          throw new Error("custom UI should not be used in RPC mode");
        }),
        select: vi.fn(async (_title: string, options: string[]) => options[0]),
      },
    } as never;

    const result = await openCommandPanel(ctx, {
      title: "Test panel",
      actions: [
        { value: "status", label: "Show status", description: "Display status", group: "Status" },
        { value: "close", label: "Close", description: "Dismiss", group: "Lifecycle" },
      ],
      closeValue: "close",
      onAction,
    });

    expect(result).toBe("status");
    expect(onAction).toHaveBeenCalledWith("status");
    expect((ctx as { ui: { custom: ReturnType<typeof vi.fn> } }).ui.custom).not.toHaveBeenCalled();
  });

  it("returns null without UI instead of trying to render a panel", async () => {
    const result = await openCommandPanel(
      { mode: "print", hasUI: false, cwd: process.cwd(), ui: {} } as never,
      {
        title: "Test panel",
        actions: [
          { value: "status", label: "Show status", description: "Display status", group: "Status" },
        ],
        closeValue: "status",
      },
    );

    expect(result).toBeNull();
  });

  it("honors native selection remaps and unmounts before a close-before action", async () => {
    let panel: ExtensionRows | undefined;
    let mounted = false;
    const state: CommandPanelState = {};
    const host: ExtensionUiHost = {
      size: () => ({ columns: 80, rows: 24 }),
      requestRender: vi.fn(),
      suspend: (run) => run(),
    };
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as ExtensionTheme;
    const keybindings = KeybindingsManager.inMemory({ "tui.select.down": "ctrl+n" });
    const ctx = {
      mode: "tui",
      hasUI: true,
      cwd: process.cwd(),
      ui: {
        custom: (factory: ExtensionCustomFactory<string | null>) => {
          const { promise, resolve } = Promise.withResolvers<string | null>();
          mounted = true;
          panel = factory(host, theme, keybindings, (result) => {
            mounted = false;
            resolve(result);
          }) as ExtensionRows;
          return promise;
        },
      },
    } as never;
    const onAction = vi.fn(() => {
      expect(mounted).toBe(false);
    });
    const result = openCommandPanel(ctx, {
      title: "Test panel",
      actions: [
        { value: "status", label: "Show status", description: "Display status", group: "Status" },
        { value: "reload", label: "Reload", description: "Reload extension", group: "Lifecycle" },
        { value: "close", label: "Close", description: "Dismiss", group: "Lifecycle" },
      ],
      closeValue: "close",
      state,
      onAction,
      closeBeforeAction: (action) => action === "reload",
    });

    expect(panel?.render(80).join("\n")).toContain("Show status");
    expect(state.selectedValue).toBe("status");
    panel?.handleInput?.("\x1b[B"); // A remapped Down no longer moves the selection.
    expect(state.selectedValue).toBe("status");
    panel?.handleInput?.("\x0e"); // Ctrl+N
    expect(state.selectedValue).toBe("reload");
    panel?.handleInput?.("\r");

    await expect(result).resolves.toBe("close");
    expect(onAction).toHaveBeenCalledExactlyOnceWith("reload");
  });
});

describe("isLifecycleToggleAction", () => {
  // This predicate is what every /sf-* command panel passes as
  // `closeBeforeAction`. Changing the literal string would silently break
  // the close-before-reload contract in 9 extensions.
  it("matches the canonical lifecycle action id", () => {
    expect(isLifecycleToggleAction("lifecycle.toggle")).toBe(true);
  });

  it("rejects close, status, refresh, and unrelated values", () => {
    expect(isLifecycleToggleAction("close")).toBe(false);
    expect(isLifecycleToggleAction("status")).toBe(false);
    expect(isLifecycleToggleAction("refresh")).toBe(false);
    expect(isLifecycleToggleAction("help")).toBe(false);
    expect(isLifecycleToggleAction("")).toBe(false);
  });

  it("is exact-match (no prefix / case lenience)", () => {
    expect(isLifecycleToggleAction("Lifecycle.toggle")).toBe(false);
    expect(isLifecycleToggleAction("lifecycle.toggle.x")).toBe(false);
    expect(isLifecycleToggleAction("lifecycle-toggle")).toBe(false); // hyphen, not dot
  });
});
