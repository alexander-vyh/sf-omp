/* SPDX-License-Identifier: Apache-2.0 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPublicFailures } from "../lib/eval/actions/evidence.ts";
import { readEvalRunArtifact } from "../lib/eval-studio/artifact-reader.ts";
import { EvalStudioComponent } from "../lib/eval-studio/component.ts";
import type { StudioInventory, StudioRunSummary } from "../lib/eval-studio/types.ts";
import type { DependencyFingerprint } from "../lib/release-dependencies.ts";
import type * as EvalClient from "../lib/eval/eval-client.ts";
import { runEval } from "../lib/eval/orchestrator.ts";

const callEval = vi.hoisted(() => vi.fn());
vi.mock("../lib/eval/eval-client.ts", async (original) => ({
  ...(await original<typeof EvalClient>()),
  callEval,
}));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const fingerprint: DependencyFingerprint = {
  schema_version: 1,
  targets: [{ scheme: "generatePromptResponse", ref_name: "AnswerTemplate" }],
  dependencies: [
    {
      kind: "prompt_template",
      name: "AnswerTemplate",
      active_version_identifier: "v1",
      content_sha256: "synthetic-content-hash",
    },
  ],
};

describe("release dependency artifact consumers", () => {
  it("writes schema-3 dependency evidence before execution and preserves it in terminal metadata", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "release-fingerprint-persistence-"));
    dirs.push(cwd);
    const runDir = path.join(cwd, "release");
    callEval.mockImplementationOnce(async () => {
      const manifest = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({ schema_version: 3, dependency_fingerprint: fingerprint });
      return {
        status: 200,
        endpoint: "test.",
        endpoint_cache: "miss",
        body: {
          results: [
            {
              id: "scenario",
              evaluation_results: [{ id: "ok", type: "evaluator.string_assertion", is_pass: true }],
            },
          ],
        },
      };
    });
    const result = await runEval({
      cwd,
      runBase: cwd,
      runId: "release",
      targetOrg: "synthetic-test-org",
      tracesMode: "off",
      conn: {
        instanceUrl: "https://example.invalid",
        identity: async () => ({ user_id: "synthetic-user", organization_id: "synthetic-org" }),
      } as never,
      specPath: "tests/agentforce/Demo.eval.json",
      spec: {
        tests: [{ id: "scenario", steps: [{ id: "ok", type: "evaluator.string_assertion" }] }],
      },
      releaseContract: {
        kind: "generated_baseline",
        baseline_id: "synthetic-baseline",
        spec_digest: "synthetic-digest",
      },
      dependencyFingerprint: fingerprint,
    });
    expect(result.metadata.dependency_fingerprint).toEqual(fingerprint);
    expect(
      JSON.parse(await readFile(path.join(runDir, "metadata.json"), "utf8")).dependency_fingerprint,
    ).toEqual(fingerprint);
    expect(result.metadata.evidence_verdict).toBe("passed");
    expect(callEval).toHaveBeenCalledOnce();
  });

  it.each([2, 3])(
    "reads schema %s failure evidence without exposing seeded values",
    async (schema) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "release-failure-schema-"));
      dirs.push(cwd);
      const runDir = path.join(cwd, ".pi", "state", "sf-agentscript", "runs", "release");
      await mkdir(runDir, { recursive: true });
      await writeFile(
        path.join(runDir, "manifest.json"),
        JSON.stringify({
          schema_version: schema,
          run_id: "release",
          seed_provenance: [{ scenario_id: "scenario", names: ["customer_key"] }],
        }),
      );
      await writeFile(
        path.join(runDir, "spec.executed.snapshot.json"),
        JSON.stringify({
          tests: [
            {
              id: "scenario",
              steps: [
                {
                  type: "agent.send_message",
                  id: "turn",
                  context_variables: [
                    { name: "customer_key", type: "Text", value: "synthetic-sensitive-key" },
                  ],
                },
              ],
            },
          ],
        }),
      );
      await writeFile(
        path.join(runDir, "failures.jsonl"),
        `${JSON.stringify({
          test_id: "scenario",
          failed_evaluators: [{ actual_value: "synthetic-sensitive-key" }],
          step_errors: [],
          turns: [],
          trace_files: [],
        })}\n`,
      );
      const failures = await readPublicFailures({ cwd } as never, "release");
      expect(failures).toHaveLength(1);
      expect(JSON.stringify(failures)).not.toContain("synthetic-sensitive-key");
    },
  );

  it.each([2, 3])(
    "displays schema %s while trusting fingerprints only in schema 3",
    async (schema) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "release-studio-schema-"));
      dirs.push(cwd);
      const runDir = path.join(cwd, "release");
      await mkdir(runDir);
      await writeFile(
        path.join(runDir, "manifest.json"),
        JSON.stringify({
          schema_version: schema,
          run_id: "release",
          scope: "suite",
          agent_api_name: "Demo",
          release_contract: { kind: "generated_baseline" },
          dependency_fingerprint: fingerprint,
        }),
      );
      const artifact = await readEvalRunArtifact(runDir);
      expect(artifact.summary.classification).toBe("current");
      expect(artifact.summary.release_contract?.kind).toBe("generated_baseline");
      expect(artifact.summary.dependency_fingerprint).toEqual(
        schema === 3 ? fingerprint : undefined,
      );
    },
  );

  it.each([true, false])(
    "shows recorded dependency evidence or a legacy rerun warning (%s)",
    (current) => {
      const run: StudioRunSummary = {
        run_id: "release",
        run_dir: "/synthetic/release",
        classification: "current",
        scope: "suite",
        release_contract: { kind: "generated_baseline" },
        ...(current ? { dependency_fingerprint: fingerprint } : {}),
      };
      const inventory: StudioInventory = {
        issues: [],
        unassigned_runs: [],
        suites: [
          {
            id: "demo",
            path: "/synthetic/Demo.eval.json",
            display_name: "Demo",
            agent_api_name: "Demo",
            designated: true,
            source_digest: "digest",
            runs: [run],
            projection: { projectable: true, issues: [], scenarios: [] },
          },
        ],
      };
      const theme = {
        fg: (_name: string, text: string) => text,
        bold: (text: string) => text,
      } as never;
      const glyphs = new Proxy({}, { get: () => "*" }) as never;
      const component = new EvalStudioComponent(theme, inventory, glyphs, vi.fn());
      component.setTerminalRows(40);
      component.handleInput("\t");
      component.handleInput("\t");
      const text = component.render(160).join("\n");
      expect(text).toContain("recorded dependencies");
      expect(text).toContain(
        current ? "AnswerTemplate" : "no dependency fingerprint, rerun required",
      );
      if (current) expect(text).toContain("synthetic-content-hash");
      expect(text).toContain("Activation rechecks dependencies");
    },
  );
});
