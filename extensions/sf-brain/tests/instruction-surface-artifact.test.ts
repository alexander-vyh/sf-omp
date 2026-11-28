/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";

import { renderInstructionSurfaceMarkdown } from "../lib/instruction-surface-artifact.ts";
import { buildInstructionSurfaceReport } from "../lib/instruction-surface-report.ts";
import { OMP_UNAVAILABLE_SURFACES } from "../lib/instruction-surface-runtime.ts";

describe("Instruction Surface contributor artifact", () => {
  it("renders public-safe Markdown from report measurements only", () => {
    const report = buildInstructionSurfaceReport({
      mode: "bundled_baseline",
      systemPrompt: "PRIVATE PROMPT BODY",
      selectedTools: ["sf_apex"],
      tools: [{ name: "sf_apex", description: "Apex", parameters: { type: "object" } }],
      skills: [],
      contextMessages: [],
      sfPiToolNames: ["sf_apex"],
      sfPiPackageRoot: "/private/repo",
      externalSalesforceSkillRoots: [],
      piRuntimeVersion: "0.82.1",
      sfPiVersion: "1.0.0",
    });

    const markdown = renderInstructionSurfaceMarkdown(report);
    expect(markdown).toContain("# Instruction Surface Report");
    expect(markdown).toContain("| SF Pi-owned | ");
    expect(markdown).toContain("sf_apex");
    expect(markdown).not.toContain("PRIVATE PROMPT BODY");
    expect(markdown).not.toContain("/private/repo");
  });

  it("marks surfaces the host does not expose as unavailable", () => {
    const report = buildInstructionSurfaceReport({
      mode: "current_session",
      systemPrompt: "base",
      selectedTools: [],
      tools: [],
      skills: [],
      contextMessages: [],
      sfPiToolNames: [],
      sfPiPackageRoot: "/repo",
      externalSalesforceSkillRoots: [],
      unavailable: OMP_UNAVAILABLE_SURFACES,
    });

    const markdown = renderInstructionSurfaceMarkdown(report);
    expect(markdown).toContain("| External Salesforce skills | unavailable | unavailable |");
    expect(markdown).toContain("| Tool guidance | unavailable | unavailable | unavailable |");
    expect(markdown).toContain(
      "| Bundled extension skills | unavailable | unavailable | unavailable |",
    );
    expect(markdown).toContain("## Unavailable on this host");
    for (const item of OMP_UNAVAILABLE_SURFACES) {
      expect(markdown).toContain(`- \`${item.surface}\`: ${item.reason}`);
    }
  });
});
