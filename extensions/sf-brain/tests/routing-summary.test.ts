/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";

import {
  formatSfPiRoutingSummary,
  SF_PI_ROUTING_CLOSE_TAG,
  SF_PI_ROUTING_OPEN_TAG,
} from "../lib/routing-summary.ts";

const PACKAGED = new Set(["sf-brain", "sf-apex", "sf-soql", "sf-agentscript"]);

describe("SF Pi Routing Summary", () => {
  it("keeps the all-available summary tiny and does not repeat the extension catalog", () => {
    const summary = formatSfPiRoutingSummary(
      new Set(["sf_apex", "sf_soql", "agentscript_authoring", "read"]),
      PACKAGED,
    );

    expect(summary.startsWith(SF_PI_ROUTING_OPEN_TAG)).toBe(true);
    expect(summary.endsWith(SF_PI_ROUTING_CLOSE_TAG)).toBe(true);
    expect(summary).toContain(
      "Family tools perform the action. Skills are supplemental playbooks; they do not own the turn.",
    );
    expect(summary).toContain("Unavailable capability owners: none.");
    expect(summary.split("\n").length).toBeLessThanOrEqual(5);
  });

  it("treats an owner as available when any one of its declared tools registered", () => {
    const summary = formatSfPiRoutingSummary(
      new Set(["sf_apex", "sf_soql", "agentscript_preview"]),
      PACKAGED,
    );

    expect(summary).toContain("Unavailable capability owners: none.");
  });

  it("lists packaged tool owners whose tools did not register, without a Manager recovery path", () => {
    const summary = formatSfPiRoutingSummary(new Set(["sf_soql"]), PACKAGED);

    expect(summary).toContain("- sf-apex — Apex lifecycle");
    expect(summary).toContain("- sf-agentscript — Agentforce Agent Script");
    expect(summary).not.toContain("- sf-soql");
    expect(summary).not.toContain("/sf-pi enable");
  });

  it("never reports extensions absent from the package manifest", () => {
    const summary = formatSfPiRoutingSummary(
      new Set(["sf_apex", "sf_soql", "agentscript_eval"]),
      PACKAGED,
    );

    expect(summary).toContain("Unavailable capability owners: none.");
    expect(summary).not.toContain("sf-docs");
  });
});
