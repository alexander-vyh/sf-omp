/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Tests for extension state building.
 *
 * Covers: buildExtensionStates
 *
 * This determines which extensions are shown as enabled/disabled in the TUI
 * overlay and list commands, from the disabled-file set read out of OMP's
 * `disabledExtensions`.
 */
import { describe, expect, it } from "vitest";
import { buildExtensionStates } from "../index.ts";

// -------------------------------------------------------------------------------------------------
// buildExtensionStates
// -------------------------------------------------------------------------------------------------

describe("buildExtensionStates", () => {
  it("marks all extensions enabled when disabledFiles is empty", () => {
    const states = buildExtensionStates(new Set());
    for (const state of states) {
      expect(state.enabled).toBe(true);
    }
  });

  it("marks specific extensions as disabled", () => {
    const disabled = new Set(["extensions/sf-ohana-spinner/index.ts"]);
    const states = buildExtensionStates(disabled);

    const spinner = states.find((s) => s.id === "sf-ohana-spinner");
    expect(spinner).toBeDefined();
    expect(spinner!.enabled).toBe(false);

    const gateway = states.find((s) => s.id === "sf-llm-gateway");
    expect(gateway).toBeDefined();
    expect(gateway!.enabled).toBe(true);
  });

  it("always marks alwaysActive extensions as enabled even if in disabled set", () => {
    const disabled = new Set(["extensions/sf-pi-manager/index.ts"]);
    const states = buildExtensionStates(disabled);

    const manager = states.find((s) => s.id === "sf-pi-manager");
    expect(manager).toBeDefined();
    expect(manager!.enabled).toBe(true);
  });

  it("returns states for all registry entries", () => {
    const states = buildExtensionStates(new Set());
    expect(states.length).toBeGreaterThanOrEqual(3);
  });

  it("preserves extension metadata from registry", () => {
    const states = buildExtensionStates(new Set());
    const spinner = states.find((s) => s.id === "sf-ohana-spinner");
    expect(spinner).toBeDefined();
    expect(spinner!.name).toBe("SF Ohana Spinner");
    expect(spinner!.category).toBe("ui");
    expect(spinner!.file).toBe("extensions/sf-ohana-spinner/index.ts");
  });
});
