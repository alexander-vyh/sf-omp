/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, test } from "vitest";
import { lintEvalRubrics } from "../lib/eval/rubric-lint.ts";
import type { EvalSpec } from "../lib/eval/types.ts";

function spec(expected: string): EvalSpec {
  return {
    tests: [
      {
        id: "refusal",
        steps: [{ type: "evaluator.bot_response_rating", id: "meaning", expected }],
      },
    ],
  };
}

describe("rubric wording lint", () => {
  test.each([
    'The agent says "I cannot create a ticket".',
    "The agent says 'I cannot create a ticket'.",
    "The agent says “I cannot create a ticket”.",
    "The agent says ‘I cannot create a ticket’.",
    "The agent says `I cannot create a ticket`.",
  ])("warns on quoted literal phrases: %s", (rubric) => {
    expect(lintEvalRubrics(spec(rubric))).toEqual([
      {
        test_id: "refusal",
        step_id: "meaning",
        code: "quoted_phrase",
        message: expect.stringContaining("behavior"),
      },
    ]);
  });

  test("flags responds with case-insensitively and returns both findings", () => {
    const input = spec('The agent RESPONDS WITH "Ticket created".');
    expect(lintEvalRubrics(input).map((warning) => warning.code)).toEqual([
      "quoted_phrase",
      "responds_with",
    ]);
    expect(input.tests[0].steps[0].expected).toBe('The agent RESPONDS WITH "Ticket created".');
  });

  test("allows semantic rubrics and ordinary apostrophes", () => {
    expect(
      lintEvalRubrics(
        spec(
          "The response addresses the user's request, acknowledges the caller's concern, and doesn't claim to have created a ticket.",
        ),
      ),
    ).toEqual([]);
    expect(lintEvalRubrics(spec("Cites a source page and explains the refusal category."))).toEqual(
      [],
    );
  });

  test("does not inspect utterances, literal deterministic data, or non-string expectations", () => {
    expect(
      lintEvalRubrics({
        tests: [
          {
            id: "behavior",
            steps: [
              { type: "agent.send_message", id: "turn1", utterance: 'Responds with "example"' },
              { type: "evaluator.string_assertion", id: "state", expected: '"blocked"' },
              { type: "evaluator.list_assertion", id: "actions", expected: ["create_ticket"] },
              { type: "evaluator.bot_response_rating", id: "missing" },
              { type: "evaluator.bot_response_rating", id: "structured", expected: {} },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });
});
