/* SPDX-License-Identifier: Apache-2.0 */
/** Advisory wording checks; never rewrite rubrics or change an eval verdict. */
import type { EvalSpec } from "./types.ts";

export interface RubricLintWarning {
  test_id: string;
  step_id: string;
  code: "quoted_phrase" | "responds_with";
  message: string;
}

// Apostrophes inside words are not quotation delimiters.
const QUOTED_PHRASE =
  /"[^"\r\n]+"|“[^”\r\n]+”|`[^`\r\n]+`|(?<![\p{L}\p{N}])'[^'\r\n]+'(?![\p{L}\p{N}])|‘[^’\r\n]+’/u;

export function lintEvalRubrics(spec: EvalSpec): RubricLintWarning[] {
  const warnings: RubricLintWarning[] = [];
  for (const test of spec.tests) {
    for (const step of test.steps) {
      if (step.type !== "evaluator.bot_response_rating" || typeof step.expected !== "string") {
        continue;
      }
      if (QUOTED_PHRASE.test(step.expected)) {
        warnings.push({
          test_id: test.id,
          step_id: step.id,
          code: "quoted_phrase",
          message:
            "Quoted phrases can make a rubric depend on wording. Describe the behavior or use a deterministic assertion for literal data.",
        });
      }
      if (/\bresponds\s+with\b/i.test(step.expected)) {
        warnings.push({
          test_id: test.id,
          step_id: step.id,
          code: "responds_with",
          message:
            "Replace 'responds with' with the semantic behavior being tested; allow equivalent wording.",
        });
      }
    }
  }
  return warnings;
}
