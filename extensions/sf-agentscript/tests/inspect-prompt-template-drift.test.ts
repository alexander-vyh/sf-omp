/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolTestContext } from "../../../lib/common/tests/extension-tool-context.ts";
import { registerAuthoringTool } from "../lib/authoring-tool.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const mocks = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn() }));
vi.mock("../lib/agent-api-auth.ts", () => ({
  connForAgentApi: vi.fn(async () => ({
    conn: { metadata: { read: mocks.read }, request: mocks.request },
    cache: "hit",
  })),
}));
vi.mock("../lib/analysis-snapshot.ts", () => ({
  getAgentScriptAnalysis: vi.fn(async () => ({
    getInspect: async () => ({
      ok: true,
      components: {
        actions: [{ name: "reply", target: "generatePromptResponse://Example_Reply" }],
      },
    }),
  })),
}));
vi.mock("../lib/preflight/index.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  checkConnectedAgentReadinessGraph: vi.fn(async () => ({ nodes: [], issues: [] })),
}));

let root: string;
let agentFile: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-inspect-prompt-drift-"));
  agentFile = path.join(root, "Example.agent");
  await writeFile(agentFile, 'config:\n    agent_name: "Example"\n');
  await writeFile(
    path.join(root, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app" }] }),
  );
  const templates = path.join(root, "force-app/main/default/genAiPromptTemplates");
  await mkdir(templates, { recursive: true });
  await writeFile(
    path.join(templates, "Example_Reply.genAiPromptTemplate-meta.xml"),
    `<GenAiPromptTemplate>
<activeVersionIdentifier>synthetic-v1</activeVersionIdentifier>
<templateVersions><versionIdentifier>synthetic-v1</versionIdentifier><content>New reply.</content></templateVersions>
</GenAiPromptTemplate>`,
  );
  mocks.read.mockReset().mockResolvedValue({
    activeVersionIdentifier: "synthetic-v1",
    templateVersions: [{ versionIdentifier: "synthetic-v1", content: "Old reply." }],
  });
  mocks.request.mockReset().mockResolvedValue({ records: [{ DeveloperName: "Example_Reply" }] });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("authoring inspect/check_targets prompt drift", () => {
  it("exposes the warning in text and details without changing existing target verdicts", async () => {
    let tool: ToolDefinition | undefined;
    registerAuthoringTool({
      registerTool: (definition: ToolDefinition) => {
        tool = definition;
      },
    } as never);
    if (!tool) throw new Error("Authoring tool was not registered");
    const result = await tool.execute(
      "synthetic-check-targets",
      {
        verb: "inspect",
        mode: "check_targets",
        agent_file: agentFile,
        target_org: "synthetic-sandbox",
      },
      undefined,
      undefined,
      createToolTestContext({ cwd: root }),
    );
    expect(result.details).toMatchObject({
      ok: true,
      action: "inspect.check_targets",
      resolved: 1,
      missing: 0,
      targets: [expect.objectContaining({ status: "ok" })],
      prompt_template_drift: {
        warnings: [
          expect.objectContaining({
            name: "Example_Reply",
            detail: expect.stringContaining("content differs but active version unchanged"),
          }),
        ],
        unverifiable: [],
      },
    });
    expect(JSON.stringify(result.content)).toContain(
      "content differs but active version unchanged",
    );
    expect(mocks.read).toHaveBeenCalledOnce();
  });
});
