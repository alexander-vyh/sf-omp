/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";

import { SF_PI_REGISTRY } from "../../../catalog/registry.ts";
import {
  formatSfPiRoutingSummary,
  SF_PI_ROUTING_CLOSE_TAG,
  SF_PI_ROUTING_OPEN_TAG,
} from "../lib/routing-summary.ts";

const ALL_TOOLS = new Set(SF_PI_REGISTRY.flatMap((extension) => extension.tools ?? []));
const without = (...names: string[]) =>
  new Set([...ALL_TOOLS].filter((tool) => !names.includes(tool)));

describe("SF Pi Routing Summary", () => {
  it("keeps the all-available summary tiny and does not repeat the extension catalog", () => {
    const summary = formatSfPiRoutingSummary(ALL_TOOLS);

    expect(summary.startsWith(SF_PI_ROUTING_OPEN_TAG)).toBe(true);
    expect(summary.endsWith(SF_PI_ROUTING_CLOSE_TAG)).toBe(true);
    expect(summary).toContain(
      "Family tools perform the action. Skills are supplemental playbooks; they do not own the turn.",
    );
    expect(summary).toContain("Unavailable capability owners: none.");
    expect(summary.split("\n").length).toBeLessThanOrEqual(5);
  });

  it("treats an owner as available when any one of its declared tools registered", () => {
    const summary = formatSfPiRoutingSummary(without("agentscript_eval", "agentscript_preview"));

    expect(summary).toContain("Unavailable capability owners: none.");
  });

  it("offers the Manager enable path only for owners the user disabled", () => {
    const summary = formatSfPiRoutingSummary(without("sf_apex", "sf_soql"), new Set(["sf-apex"]));

    expect(summary).toContain("- sf-apex — Apex lifecycle");
    expect(summary).toContain("Disabled; enable: /sf-pi enable sf-apex");
    expect(summary).toContain("- sf-soql — schema-aware SOQL");
    expect(summary).toContain(
      "sf-soql — schema-aware SOQL and SOSL lifecycle. Declared tools not registered.",
    );
    expect(summary).not.toContain("/sf-pi enable sf-soql");
  });
});
