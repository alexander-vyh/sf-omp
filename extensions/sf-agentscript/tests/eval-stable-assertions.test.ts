/* SPDX-License-Identifier: Apache-2.0 */
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { inspectFile, type InspectResult } from "../lib/inspect.ts";
import { generateSpec } from "../lib/eval/spec-generator.ts";

function source(overrides: Partial<NonNullable<InspectResult["components"]>>): InspectResult {
  return {
    ok: true,
    components: { topics: [], subagents: [], variables: [], actions: [], ...overrides },
    stats: { topics: 0, subagents: 0, variables: 0, actions: 0 },
  };
}

describe("stable generated assertions", () => {
  test("an existing agent fixture has no response rubric requiring specific wording", async () => {
    const inspect = await inspectFile(
      fileURLToPath(new URL("./fixtures/NativeLocal.agent", import.meta.url)),
    );
    expect(inspect.ok).toBe(true);
    const { spec } = generateSpec({ inspect });
    const rubrics = spec.tests.flatMap((row) =>
      row.steps
        .filter((step) => step.type === "evaluator.bot_response_rating")
        .map((step) => step.expected),
    );
    expect(rubrics.length).toBeGreaterThan(0);
    for (const rubric of rubrics) {
      expect(rubric).not.toMatch(/responds with|exact (?:words|wording|phrase)|["“][^"”]+["”]/i);
    }
    expect(spec.tests.flatMap((row) => row.steps)).toContainEqual(
      expect.objectContaining({
        type: "evaluator.string_assertion",
        expected: "primary",
        operator: "equals",
      }),
    );
  });

  test("legacy topic rubrics judge relevance without copying the generated utterance", () => {
    const { spec } = generateSpec({
      inspect: source({ topics: [{ name: "orders", description: 'Track "current" orders.' }] }),
      includeGuardrail: false,
      includeSafetyProbes: false,
    });
    const steps = spec.tests[0].steps;
    const send = steps.find((step) => step.type === "agent.send_message")!;
    const rating = steps.find((step) => step.type === "evaluator.bot_response_rating")!;
    expect(rating.expected).not.toContain(send.utterance);
    expect(rating.expected).toMatch(/meaning|behavior|behaviour/i);
  });

  test("state-grounded follow-up rubrics explicitly permit paraphrases", () => {
    const { spec } = generateSpec({
      inspect: source({
        start_agents: [
          {
            name: "main",
            state_branches: [
              {
                variable: "completed",
                operator: "truthy",
                expected: true,
                instructions: "Report that the helper completed successfully.",
              },
            ],
          },
        ],
        variables: [{ name: "completed", type: "boolean", mutable: true, default: false }],
        connected_subagents: [
          {
            name: "status_helper",
            description: "Retrieve the request status.",
            target: "agent://Status_Helper",
            has_after_response: true,
            after_response_updates: [{ variable: "completed", operation: "set", value: true }],
          },
        ],
      }),
      includeGuardrail: false,
      includeSafetyProbes: false,
    });
    const steps = spec.tests[0].steps;
    const followUp = steps.find(
      (step) => step.id === "eval_second_turn_connected_agent_status_helper",
    )!;
    expect(followUp.expected).toMatch(/paraphrases/i);
    expect(followUp.expected).toContain("Report that the helper completed successfully.");
    expect(steps.filter((step) => step.type === "evaluator.numeric_assertion")).toHaveLength(2);
  });
});
