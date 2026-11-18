/* SPDX-License-Identifier: Apache-2.0 */
import type { Connection } from "@salesforce/core";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPromptTemplateDrift } from "../../lib/preflight/prompt-template-drift.ts";

let root: string;
let agentFile: string;
let sourceFile: string;
const actions = [{ name: "answer", target: "generatePromptResponse://Example_Reply" }];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-prompt-drift-"));
  agentFile = path.join(root, "force-app/main/default/aiAuthoringBundles/Example/Example.agent");
  sourceFile = path.join(
    root,
    "force-app/main/default/genAiPromptTemplates/Example_Reply.genAiPromptTemplate-meta.xml",
  );
  await mkdir(path.dirname(agentFile), { recursive: true });
  await mkdir(path.dirname(sourceFile), { recursive: true });
  await writeFile(
    path.join(root, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app" }] }),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function local(content = "Edited reply.", version = "synthetic-v1") {
  await writeFile(
    sourceFile,
    `<GenAiPromptTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
  <activeVersionIdentifier>${version}</activeVersionIdentifier>
  <templateVersions><content>${content}</content><versionIdentifier>${version}</versionIdentifier></templateVersions>
  <templateVersions><content>Inactive text.</content><versionIdentifier>synthetic-inactive</versionIdentifier></templateVersions>
</GenAiPromptTemplate>`,
  );
}
function org(content = "Original reply.", version = "synthetic-v1") {
  const read = vi.fn().mockResolvedValue([
    {
      activeVersionIdentifier: version,
      templateVersions: [{ versionIdentifier: version, content }],
    },
  ]);
  return { conn: { metadata: { read } } as unknown as Connection, read };
}

describe("prompt template content drift", () => {
  it("warns on different content with the same active identifier using the Metadata API seam", async () => {
    await local();
    const { conn, read } = org();
    const result = await checkPromptTemplateDrift(conn, actions, agentFile);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        name: "Example_Reply",
        detail: expect.stringContaining("content differs but active version unchanged"),
      }),
    ]);
    expect(result.warnings[0].detail).toMatch(/bump.*identifier.*activation/i);
    expect(result.unverifiable).toEqual([]);
    expect(read).toHaveBeenCalledWith("GenAiPromptTemplate", ["Example_Reply"]);
    expect(JSON.stringify(result)).not.toContain("Edited reply.");
  });
  it("does not warn when active content matches", async () => {
    await local();
    const { conn } = org("Edited reply.");
    expect((await checkPromptTemplateDrift(conn, actions, agentFile)).warnings).toEqual([]);
  });
  it("does not warn when the local active identifier differs", async () => {
    await local("Edited reply.", "synthetic-v2");
    const { conn } = org();
    expect((await checkPromptTemplateDrift(conn, actions, agentFile)).warnings).toEqual([]);
  });
  it("preserves content whitespace and decodes XML entities and CDATA before hashing", async () => {
    await local("  First &amp; second.\n<![CDATA[<reply>]]>  ");
    const { conn } = org("  First & second.\n<reply>  ");
    expect((await checkPromptTemplateDrift(conn, actions, agentFile)).warnings).toEqual([]);
  });
  it("does no org read when local source is absent", async () => {
    const { conn, read } = org();
    expect(await checkPromptTemplateDrift(conn, actions, agentFile)).toEqual({
      warnings: [],
      unverifiable: [],
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("deduplicates repeated targets within a check", async () => {
    await local();
    const { conn, read } = org();
    const result = await checkPromptTemplateDrift(
      conn,
      [...actions, { ...actions[0], name: "again" }],
      agentFile,
    );
    expect(result.warnings).toHaveLength(1);
    expect(read).toHaveBeenCalledOnce();
  });
  it("reports failed org evidence as unverifiable, never as a drift warning", async () => {
    await local();
    const { conn, read } = org();
    read.mockRejectedValue(new Error("Synthetic lookup failure"));
    const result = await checkPromptTemplateDrift(conn, actions, agentFile);
    expect(result.warnings).toEqual([]);
    expect(result.unverifiable).toEqual([expect.objectContaining({ name: "Example_Reply" })]);
  });
  it("does not treat malformed local XML as valid evidence", async () => {
    await writeFile(sourceFile, "<GenAiPromptTemplate><content>broken");
    const { conn, read } = org();
    const result = await checkPromptTemplateDrift(conn, actions, agentFile);
    expect(result.warnings).toEqual([]);
    expect(result.unverifiable).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
  });
});
