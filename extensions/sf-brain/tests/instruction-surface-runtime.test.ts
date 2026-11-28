/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";

import {
  captureInstructionSurfaceReport,
  OMP_UNAVAILABLE_SURFACES,
} from "../lib/instruction-surface-runtime.ts";

describe("captureInstructionSurfaceReport", () => {
  it("uses active OMP tools and the latest model-visible branch context without exposing content", () => {
    // OMP's getAllTools() ToolInfo: identity and schema only, no snippets or guidelines.
    const pi = {
      getAllTools: () => [
        { name: "sf_apex", description: "Apex lifecycle", parameters: { type: "object" } },
        { name: "sf_soql", description: "SOQL lifecycle", parameters: { type: "object" } },
      ],
      getActiveTools: () => ["sf_apex"],
    };
    const ctx = {
      getSystemPrompt: () => ["BASE SYSTEM PROMPT", "POLICY BLOCK"],
      sessionManager: {
        getBranch: () => [
          {
            type: "custom_message",
            customType: "sf-brain-constitution",
            content: "OLD CONSTITUTION",
          },
          {
            type: "custom_message",
            customType: "sf-brain-constitution",
            content: "LATEST CONSTITUTION",
          },
          {
            type: "custom_message",
            customType: "sf-display-only",
            content: "NOT SENT TO THE MODEL",
            excludeFromContext: true,
          },
          { type: "custom", customType: "sf-brain-state", data: { secret: true } },
        ],
      },
    };

    const report = captureInstructionSurfaceReport(pi, ctx, {
      sfPiPackageRoot: "/repo",
      sfPiToolNames: ["sf_apex", "sf_soql"],
      piRuntimeVersion: "19.2.1",
      sfPiVersion: "1.2.3",
    });

    expect(report.summary.system_prompt_chars).toBe("BASE SYSTEM PROMPT\n\nPOLICY BLOCK".length);
    expect(report.sections.sf_pi_tool_definitions.items).toBe(1);
    expect(report.sections.sf_pi_hidden_context.items).toBe(1);
    expect(report.sections.sf_pi_hidden_context.chars).toBe("LATEST CONSTITUTION".length);
    expect(report.pi_runtime_version).toBe("19.2.1");
    expect(report.unavailable).toEqual(OMP_UNAVAILABLE_SURFACES);
    expect(report.unavailable.map((item) => item.surface)).toEqual(["skills", "tool_guidance"]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("LATEST CONSTITUTION");
    expect(serialized).not.toContain("secret");
  });
});
