/* SPDX-License-Identifier: Apache-2.0 */
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { describe, expect, it } from "vitest";

import type { InstructionSurfaceBaselineComparison } from "../lib/instruction-surface-baseline.ts";
import { buildInstructionSurfaceReport } from "../lib/instruction-surface-report.ts";
import { renderInstructionSurfaceReport } from "../lib/instruction-surface-panel.ts";
import { OMP_UNAVAILABLE_SURFACES } from "../lib/instruction-surface-runtime.ts";

describe("Instruction Surface Manager panel", () => {
  it("renders a bounded content-safe diagnostic summary", () => {
    const report = buildInstructionSurfaceReport({
      mode: "current_session",
      systemPrompt: "DO NOT RENDER THIS PROMPT",
      selectedTools: ["sf_apex"],
      tools: [
        {
          name: "sf_apex",
          description: "Apex lifecycle",
          parameters: { type: "object", properties: { action: { type: "string" } } },
          promptGuidelines: ["DO NOT RENDER THIS GUIDELINE"],
        },
      ],
      skills: [],
      contextMessages: [],
      sfPiToolNames: ["sf_apex"],
      sfPiPackageRoot: "/repo",
      externalSalesforceSkillRoots: [],
    });

    const lines = renderInstructionSurfaceReport(report, 52);
    const rendered = lines.join("\n");

    expect(rendered).toContain("Instruction Surface Report");
    expect(rendered).toContain("SF Pi-owned");
    expect(rendered).toContain("Largest SF Pi contributors");
    expect(rendered).toContain("sf_apex");
    expect(rendered).not.toContain("DO NOT RENDER");
    expect(lines.every((line) => visibleWidth(line) <= 52)).toBe(true);
  });

  it("renders a compatible bundled-baseline delta without exposing baseline content", () => {
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
    });
    const comparison: InstructionSurfaceBaselineComparison = {
      comparable: true,
      baseline_sf_pi_version: "0.9.0",
      deltas: {
        sf_pi_owned_chars: -250,
        sf_pi_tool_definition_chars: 0,
        sf_pi_tool_guidance_chars: -100,
        sf_pi_hidden_context_chars: -150,
        bundled_extension_skill_chars: 0,
      },
    };

    const rendered = renderInstructionSurfaceReport(report, 80, comparison).join("\n");
    expect(rendered).toContain("Compared with bundled baseline v0.9.0");
    expect(rendered).toContain("-250");
  });

  it("shows surfaces the host does not expose as unavailable, never as zero", () => {
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

    const lines = renderInstructionSurfaceReport(report, 140);
    expect(lines).toContain(`  ${"External Salesforce skills".padEnd(29)} unavailable`);
    expect(lines).toContain(`  ${"Tool guidance".padEnd(20)} unavailable`);
    expect(lines).toContain(`  ${"Bundled skills".padEnd(20)} unavailable`);
    expect(lines).toContain("Unavailable on this host");
    for (const item of OMP_UNAVAILABLE_SURFACES) expect(lines).toContain(`  • ${item.reason}`);
  });
});
