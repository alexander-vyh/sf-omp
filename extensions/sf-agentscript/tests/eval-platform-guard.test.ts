/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizePlatformGuardResult } from "../lib/eval/normalize.ts";
import { deriveEvalVerdict } from "../lib/eval/verdict.ts";
import { renderReport, summarize } from "../lib/eval/render.ts";
import { writeRun } from "../lib/eval/persist.ts";
import type { EvalSpec, RunMetadata, TestResult } from "../lib/eval/types.ts";
import { runEval } from "../lib/eval/orchestrator.ts";
import { EvalStudioComponent } from "../lib/eval-studio/component.ts";
import type { StudioInventory } from "../lib/eval-studio/types.ts";
import type * as EvalClient from "../lib/eval/eval-client.ts";

vi.mock("../lib/eval/eval-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof EvalClient>()),
  callEval: vi.fn(async () => ({
    status: 200,
    body: { results: [fixture("lookup_status")] },
    endpoint: "",
  })),
}));

// Synthetic Evaluation API structure: markers are metadata, never user text.
function fixture(id = "safety_regulated_financial"): TestResult {
  return {
    id,
    outputs: [
      { id: "session", type: "agent.create_session", session_id: "synthetic-session" },
      { id: "turn1", type: "agent.send_message", response: "Request unavailable." },
      {
        id: "state1",
        type: "agent.get_state",
        response: {
          planner_response: {
            lastExecution: {
              topic: "Inappropriate_Content",
              llmEvents: [
                [
                  {
                    agent_name: "Inappropriate_Content",
                    prompt_name: "Inappropriate_Content_prompt",
                  },
                ],
              ],
            },
          },
        },
      },
    ],
    evaluation_results: [
      { id: "rating", type: "evaluator.bot_response_rating", is_pass: false, score: 1 },
    ],
    errors: [],
  };
}

function spec(id: string): EvalSpec {
  return {
    tests: [
      {
        id,
        steps: [
          { id: "session", type: "agent.create_session" },
          { id: "turn1", type: "agent.send_message", utterance: "Synthetic request" },
          { id: "state1", type: "agent.get_state" },
          { id: "rating", type: "evaluator.bot_response_rating" },
        ],
      },
    ],
  };
}

describe("platform guard outcomes", () => {
  it.each([
    "safety_unsolicited_pii",
    "safety_regulated_financial",
    "safety_regulated_medical",
    "guardrail_off_topic",
  ])("accepts the platform refusal for %s without mutating raw evidence", (id) => {
    const raw = fixture(id);
    const normalized = normalizePlatformGuardResult(raw);
    expect(normalized.platform_guard).toEqual({ category: "Inappropriate_Content" });
    expect(normalized.evaluation_results?.[0].is_pass).toBe(true);
    expect(raw.evaluation_results?.[0].is_pass).toBe(false);
    const result = deriveEvalVerdict(spec(id), { results: [raw] });
    expect(result.verdict).toBe("passed");
    expect(result.scenarios[0]).toMatchObject({
      verdict: "passed",
      platform_guard: normalized.platform_guard,
    });
  });

  it("keeps functional interception distinct, counted separately, and fail-closed", () => {
    const raw = fixture("lookup_status");
    const suite = spec(raw.id!);
    const result = deriveEvalVerdict(suite, { results: [raw] });
    expect(result.verdict).toBe("platform_guard");
    expect(result.scenarios[0].verdict).toBe("platform_guard");
    const summary = summarize({ results: [raw] });
    expect(summary.totals).toMatchObject({
      test_fail: 0,
      test_pass: 0,
      test_platform_guard: 1,
      ev_fail: 0,
    });
    expect(summary.failures[0]).toMatchObject({
      outcome: "platform_guard",
      platform_guard: { category: "Inappropriate_Content" },
      failed_evaluators: [],
    });
    expect(renderReport({ results: [raw] }).report).toContain(
      "platform_guard (Inappropriate_Content)",
    );
    suite.sf_pi = { platform_guard: { functional: "allow" } };
    expect(deriveEvalVerdict(suite, { results: [raw] }).verdict).toBe("passed");
    expect(deriveEvalVerdict(suite, { results: [raw] }).scenarios[0].verdict).toBe(
      "platform_guard",
    );
  });

  it("passes a Suite-designated single-turn safety test and only that test", () => {
    const medical = fixture("designated_medical_safe_response");
    const lookup = fixture("lookup_status");
    const suite = {
      tests: [...spec(medical.id!).tests, ...spec(lookup.id!).tests],
      sf_pi: { platform_guard: { safety_tests: ["designated_medical_safe_response"] } },
    };
    const result = deriveEvalVerdict(suite, { results: [medical, lookup] });
    expect(result.scenarios.map((scenario) => scenario.verdict)).toEqual([
      "passed",
      "platform_guard",
    ]);
    expect(result.verdict).toBe("platform_guard");
    const summary = summarize(
      { results: [medical, lookup] },
      { designatedSafetyTests: suite.sf_pi.platform_guard.safety_tests },
    );
    expect(summary.totals).toMatchObject({ test_pass: 1, test_platform_guard: 1 });
  });

  it("does not infer platform interception from response or prompt content", () => {
    const raw = fixture();
    raw.outputs = [
      { id: "turn1", type: "agent.send_message", response: "Inappropriate_Content_prompt" },
      {
        type: "agent.get_state",
        response: {
          planner_response: {
            lastExecution: {
              topic: "topic_selector",
              llmEvents: [[{ prompt_content: "Inappropriate_Content" }]],
            },
          },
        },
      },
    ];
    expect(normalizePlatformGuardResult(raw).platform_guard).toBeUndefined();
    expect(deriveEvalVerdict(spec(raw.id!), { results: [raw] }).verdict).toBe("failed");
  });

  it("recognizes prompt metadata alone and does not leak guards across rows", () => {
    const guarded = fixture("lookup_status");
    guarded.outputs = [
      {
        type: "agent.get_state",
        response: {
          planner_response: {
            lastExecution: {
              llmEvents: [{ prompt_name: "Inappropriate_Content_prompt" }],
            },
          },
        },
      },
    ];
    expect(normalizePlatformGuardResult(guarded).platform_guard).toEqual({
      category: "Inappropriate_Content",
    });
    const other = { ...fixture(), outputs: [] };
    const suite = { tests: [...spec(guarded.id!).tests, ...spec(other.id!).tests] };
    const result = deriveEvalVerdict(suite, { results: [guarded, other] });
    expect(result.scenarios.map((row) => row.verdict)).toEqual(["platform_guard", "failed"]);
    expect(result.verdict).toBe("failed");
  });

  it("does not hide missing evidence or step errors behind a safety guard", () => {
    const raw = fixture();
    raw.evaluation_results = [];
    expect(deriveEvalVerdict(spec(raw.id!), { results: [raw] }).verdict).toBe("incomplete");
    raw.errors = [{ id: "other", error_message: "Unrelated failure" }];
    expect(deriveEvalVerdict(spec(raw.id!), { results: [raw] }).verdict).toBe("incomplete");
  });
  it("does not promote a guarded multi-turn safety workflow to a pass", () => {
    const raw = fixture();
    raw.outputs!.push({ id: "turn2", type: "agent.send_message", response: "Another turn" });
    expect(normalizePlatformGuardResult(raw).evaluation_results?.[0].is_pass).toBeNull();
    expect(deriveEvalVerdict(spec(raw.id!), { results: [raw] }).verdict).toBe("platform_guard");
  });

  it.each(["evaluator_error", "duplicate", "step_error"] as const)(
    "keeps %s incomplete despite the safe refusal",
    (failure) => {
      const raw = fixture();
      if (failure === "evaluator_error")
        raw.evaluation_results![0].error_message = "Evaluator unavailable";
      if (failure === "duplicate") raw.evaluation_results!.push({ ...raw.evaluation_results![0] });
      if (failure === "step_error")
        raw.errors = [{ id: "other", error_message: "Unrelated error" }];
      expect(deriveEvalVerdict(spec(raw.id!), { results: [raw] }).verdict).toBe("incomplete");
    },
  );

  it("never lets functional allow policy hide another scenario's failure", () => {
    const guarded = fixture("lookup_status");
    const failed = { ...fixture("other_status"), outputs: [] };
    const suite: EvalSpec = {
      tests: [...spec(guarded.id!).tests, ...spec(failed.id!).tests],
      sf_pi: { platform_guard: { functional: "allow" } },
    };
    expect(deriveEvalVerdict(suite, { results: [guarded, failed] }).verdict).toBe("failed");
    expect(deriveEvalVerdict(suite, { results: [guarded] }).verdict).toBe("incomplete");
  });

  it("retains safe-refusal annotations without counting them as functional blocks", () => {
    const summary = summarize({ results: [fixture()] });
    expect(summary.totals).toMatchObject({
      test_pass: 1,
      test_fail: 0,
      test_platform_guard: 0,
      ev_pass: 1,
      ev_fail: 0,
      ev_platform_guard: 0,
    });
    expect(summary.failures[0]).toMatchObject({
      outcome: "passed",
      platform_guard: { category: "Inappropriate_Content" },
    });
    expect(renderReport({ results: [fixture()] }).report).toContain("safe refusal passed");
  });

  it("persists separate platform counters through the run orchestrator", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "platform-guard-run-"));
    const suite = spec("lookup_status");
    Object.assign(suite.tests[0].steps[0], { agent_id: "0Xx", agent_version_id: "0X9" });
    try {
      const result = await runEval({
        conn: {
          instanceUrl: "https://example.invalid",
          identity: async () => ({ user_id: "005", organization_id: "00D" }),
        } as never,
        targetOrg: "test-org",
        cwd: runDir,
        runBase: runDir,
        tracesMode: "off",
        spec: suite,
      });
      expect(result.metadata.evidence_verdict).toBe("platform_guard");
      expect(result.metadata.totals).toMatchObject({
        test_pass: 0,
        test_fail: 0,
        test_platform_guard: 1,
        ev_fail: 0,
        ev_platform_guard: 1,
      });
      const persisted = JSON.parse(
        await readFile(path.join(result.run_dir!, "metadata.json"), "utf8"),
      );
      expect(persisted.totals).toEqual(result.metadata.totals);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it("shows a distinct platform warning badge in Eval Studio", () => {
    const inventory: StudioInventory = {
      issues: [],
      unassigned_runs: [],
      suites: [
        {
          id: "synthetic-suite",
          path: "/project/synthetic.eval.json",
          display_name: "Synthetic",
          agent_api_name: "Synthetic",
          designated: false,
          source_digest: "synthetic",
          projection: { projectable: true, issues: [], scenarios: [] },
          runs: [
            {
              run_id: "synthetic-run",
              run_dir: "/runs/synthetic-run",
              classification: "current",
              scope: "suite",
              execution_state: "completed",
              current_verdict: "platform_guard",
              recorded_verdict: "platform_guard",
            },
          ],
        },
      ],
    };
    const component = new EvalStudioComponent(
      { fg: (_name: string, text: string) => text, bold: (text: string) => text } as never,
      inventory,
      {
        mode: "ascii",
        agent: "a",
        actions: ">",
        automation: "o",
        codeAnalyzer: "ca",
        controls: "o",
        data: "d",
        discovery: "?",
        evidence: "#",
        info: "i",
        lifecycle: "-",
        loading: "~",
        reference: "?",
        safety: "!",
        scope: "#",
        selected: ">",
        selectedRow: ">",
        status: "*",
        success: "+",
        warning: "!",
        error: "x",
      } as never,
      vi.fn(),
    );
    component.handleInput("\r");
    component.handleInput("3");
    expect(component.render(160).join("\n")).toContain("! Platform guard");
  });

  it.each([
    ["lookup_status", "platform_guard"],
    ["safety_unsolicited_pii", "passed"],
  ])("persists %s guard records while leaving raw.json untouched", async (id, outcome) => {
    const raw = fixture(id);
    const merged = { results: [raw] };
    const { totals, failures } = summarize(merged);
    const runDir = await mkdtemp(path.join(tmpdir(), "platform-guard-"));
    const metadata: RunMetadata = {
      run_id: "synthetic",
      started: "2026-01-01T00:00:00Z",
      completed: "2026-01-01T00:00:01Z",
      duration_ms: 1000,
      tests_count: 1,
      batches: 1,
      concurrency: 1,
      traces_mode: "off",
      traces_fetched: 0,
      totals,
      latency_summary: { count: 0 },
    };
    try {
      await writeRun({ runDir, merged, traces: new Map(), metadata, failures });
      expect(JSON.parse(await readFile(path.join(runDir, "failures.jsonl"), "utf8"))).toMatchObject(
        {
          outcome,
          platform_guard: { category: "Inappropriate_Content" },
        },
      );
      expect(JSON.parse(await readFile(path.join(runDir, "raw.json"), "utf8"))).toEqual(merged);
      const transcript = JSON.parse(await readFile(path.join(runDir, "transcript.jsonl"), "utf8"));
      expect(transcript.platform_guard).toEqual({ category: "Inappropriate_Content" });
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});
