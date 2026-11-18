/* SPDX-License-Identifier: Apache-2.0 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type * as SfConnection from "../../../lib/common/sf-conn/index.ts";
import type * as Lifecycle from "../lib/lifecycle.ts";
import { createToolTestContext } from "../../../lib/common/tests/extension-tool-context.ts";
import { registerLifecycleTool } from "../lib/lifecycle-tool.ts";
import { AGENT_SCRIPT_RELEASE_BASELINE_ID, hashEvalSpec } from "../lib/release-contract.ts";
import { EVAL_VERDICT_SEMANTICS_VERSION } from "../lib/eval/verdict.ts";

const mocks = vi.hoisted(() => ({ read: vi.fn(), activate: vi.fn() }));
vi.mock("../../../lib/common/sf-conn/index.ts", async (original) => ({
  ...(await original<typeof SfConnection>()),
  connFromAlias: vi.fn(async () => ({ metadata: { read: mocks.read } })),
  resolveOrgIdentity: vi.fn(async () => ({ org_id: "synthetic-org" })),
}));
vi.mock("../lib/lifecycle.ts", async (original) => ({
  ...(await original<typeof Lifecycle>()),
  listVersions: vi.fn(async () => ({
    versions: [
      {
        bot_version_id: "synthetic-version",
        version_number: 1,
        status: "Inactive",
      },
    ],
  })),
  activateVersion: mocks.activate,
}));

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "release-dependency-activation-"));
  vi.clearAllMocks();
  mocks.read.mockResolvedValue([
    {
      activeVersionIdentifier: "v1",
      templateVersions: [{ versionIdentifier: "v1", content: "Original prompt." }],
    },
  ]);
  mocks.activate.mockResolvedValue({ Id: "synthetic-version", VersionNumber: 1, Status: "Active" });
});
afterEach(async () => rm(cwd, { recursive: true, force: true }));

async function writeEvidence(schemaVersion = 3) {
  const root = path.join(cwd, ".pi", "state", "sf-agentscript");
  const run = path.join(root, "runs", "release");
  await mkdir(run, { recursive: true });
  await mkdir(path.join(root, "release-contracts"));
  const source = {
    tests: [{ id: "release", steps: [{ type: "evaluator.string_assertion", id: "ok" }] }],
  };
  const contract = {
    kind: "generated_baseline",
    baseline_id: AGENT_SCRIPT_RELEASE_BASELINE_ID,
    spec_digest: hashEvalSpec(source),
  };
  await writeFile(
    path.join(root, "release-contracts", "Demo.generated.eval.json"),
    JSON.stringify(source),
  );
  const files = {
    "manifest.json": {
      schema_version: schemaVersion,
      run_id: "release",
      scope: "suite",
      org_id: "synthetic-org",
      agent_api_name: "Demo",
      bot_version_id: "synthetic-version",
      release_contract: contract,
      source_digest: hashEvalSpec(source),
      executed_digest: hashEvalSpec(source),
      ...(schemaVersion === 3
        ? {
            dependency_fingerprint: {
              schema_version: 1,
              targets: [{ scheme: "generatePromptResponse", ref_name: "AnswerTemplate" }],
              dependencies: [
                {
                  kind: "prompt_template",
                  name: "AnswerTemplate",
                  active_version_identifier: "v1",
                  content_sha256: createHash("sha256").update("Original prompt.").digest("hex"),
                },
              ],
            },
          }
        : {}),
    },
    "metadata.json": {
      run_id: "release",
      execution_state: "completed",
      evidence_verdict: "passed",
      verdict_semantics_version: EVAL_VERDICT_SEMANTICS_VERSION,
      tests_count: 1,
      returned_tests_count: 1,
      failed_batches: 0,
      totals: { tests: 1, test_pass: 1, test_fail: 0, evals: 1, ev_pass: 1, ev_fail: 0, errors: 0 },
    },
    "status.json": { run_id: "release", status: "completed" },
    "spec.source.snapshot.json": source,
    "spec.executed.snapshot.json": source,
    "raw.json": {
      results: [
        {
          id: "release",
          evaluation_results: [
            {
              id: "ok",
              type: "evaluator.string_assertion",
              is_pass: true,
            },
          ],
        },
      ],
    },
  };
  await Promise.all(
    Object.entries(files).map(([file, content]) =>
      writeFile(path.join(run, file), JSON.stringify(content)),
    ),
  );
}

function activate(override = false) {
  let tool: ToolDefinition | undefined;
  registerLifecycleTool({
    registerTool: (definition: ToolDefinition) => {
      tool = definition;
    },
  } as never);
  return tool!.execute(
    "activate",
    {
      action: "activate",
      target_org: "synthetic-test-org",
      agent_api_name: "Demo",
      ...(override ? { acknowledge_untested_activation: true } : {}),
    },
    undefined,
    undefined,
    createToolTestContext({ cwd, sessionManager: { getBranch: () => [] } }),
  );
}

function firstText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  return block?.type === "text" ? (block.text ?? "") : "";
}

describe("registered lifecycle activation dependency gate", () => {
  it("re-resolves recorded dependencies before allowing unchanged evidence", async () => {
    await writeEvidence();
    const result = await activate();
    expect(result.details).toMatchObject({ ok: true, activation_evidence: { proceed: true } });
    expect(mocks.read).toHaveBeenCalledWith("GenAiPromptTemplate", ["AnswerTemplate"]);
    expect(mocks.activate).toHaveBeenCalledOnce();
  });

  it("blocks a same-identifier prompt content change with a named diff before mutation", async () => {
    await writeEvidence();
    mocks.read.mockResolvedValue([
      {
        activeVersionIdentifier: "v1",
        templateVersions: [{ versionIdentifier: "v1", content: "Changed prompt." }],
      },
    ]);
    const result = await activate();
    expect(result.details).toMatchObject({ ok: false, activation_evidence: { proceed: false } });
    expect(firstText(result)).toContain("AnswerTemplate");
    expect(firstText(result)).toContain("content_sha256");
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("rejects legacy evidence with a rerun instruction and no dependency lookup or mutation", async () => {
    await writeEvidence(2);
    const result = await activate();
    expect(result.details).toMatchObject({ ok: false });
    expect(firstText(result)).toContain("no dependency fingerprint, rerun required");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("uses the explicit untested override path for changed dependencies", async () => {
    await writeEvidence();
    mocks.read.mockRejectedValue(new Error("AnswerTemplate unavailable"));
    const result = await activate(true);
    expect(result.details).toMatchObject({
      ok: true,
      untested_activation_override: true,
      activation_evidence: { proceed: false },
    });
    expect(firstText(result)).toContain("untested emergency path");
    expect(mocks.activate).toHaveBeenCalledOnce();
  });
});
