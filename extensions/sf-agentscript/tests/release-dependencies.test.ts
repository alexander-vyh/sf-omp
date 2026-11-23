/* SPDX-License-Identifier: Apache-2.0 */
import type { Connection } from "@salesforce/core";
import { describe, expect, it, vi } from "vitest";
import {
  compareDependencyFingerprints,
  resolveDependencyFingerprint,
  type DependencyFingerprint,
} from "../lib/release-dependencies.ts";

const query = vi.hoisted(() => vi.fn());
vi.mock("../lib/preflight/soql.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  safeQueryRecords: query,
}));

const fingerprint: DependencyFingerprint = {
  schema_version: 1,
  targets: [{ scheme: "flow", ref_name: "AnswerFlow" }],
  dependencies: [
    {
      kind: "prompt_template",
      name: "AnswerTemplate",
      active_version_identifier: "synthetic-v1",
      content_sha256: "prompt-hash-v1",
    },
    { kind: "flow", name: "AnswerFlow", active_version_id: "synthetic-flow-v1", version_number: 1 },
    {
      kind: "apex",
      name: "AnswerSearch",
      id: "synthetic-class",
      last_modified_date: "2026-01-01T00:00:00Z",
      body_sha256: "hash-v1",
    },
  ],
};

describe("release dependency fingerprints", () => {
  it("compares canonical dependency identities without depending on order", () => {
    expect(
      compareDependencyFingerprints(fingerprint, {
        ...fingerprint,
        dependencies: [...fingerprint.dependencies].reverse(),
      }),
    ).toEqual([]);
  });
  it.each([
    [0, "active_version_identifier", "synthetic-v2", "AnswerTemplate"],
    [0, "content_sha256", "prompt-hash-v2", "AnswerTemplate"],
    [1, "active_version_id", "synthetic-flow-v2", "AnswerFlow"],
    [2, "body_sha256", "hash-v2", "AnswerSearch"],
  ])("names a changed dependency %s", (index, field, value, name) => {
    const changed = structuredClone(fingerprint);
    Object.assign(changed.dependencies[index as number], { [field]: value });
    expect(compareDependencyFingerprints(fingerprint, changed).join("; ")).toContain(name);
    expect(compareDependencyFingerprints(fingerprint, changed).join("; ")).toContain(field);
  });
  it("requires a rerun for legacy evidence, not an empty fingerprint", () => {
    expect(compareDependencyFingerprints(undefined, fingerprint)).toEqual([
      "no dependency fingerprint, rerun required",
    ]);
    expect(compareDependencyFingerprints(fingerprint, undefined)).toEqual([
      "current dependency fingerprint unavailable, rerun required",
    ]);
  });
  it("resolves active Flow, subflow, prompt template and Apex versions via bounded metadata/query seams", async () => {
    query.mockImplementation(async (_conn, _endpoint, soql: string) => {
      if (soql.includes("ApexClass"))
        return [
          {
            Id: "synthetic-class",
            LastModifiedDate: "2026-01-01T00:00:00Z",
            Body: "public class AnswerSearch {}",
          },
        ];
      if (soql.includes("'ChildFlow'"))
        return [{ Id: "synthetic-child", VersionNumber: 2, Metadata: {} }];
      return [
        {
          Id: "synthetic-parent",
          VersionNumber: 1,
          Metadata: {
            subflows: [{ flowName: "ChildFlow" }],
            actionCalls: [
              { actionType: "generatePromptResponse", actionName: "AnswerTemplate" },
              { actionType: "apex", actionName: "AnswerSearch" },
            ],
          },
        },
      ];
    });
    const read = vi.fn().mockResolvedValue([
      {
        activeVersionIdentifier: "synthetic-template-v1",
        templateVersions: [
          { versionIdentifier: "synthetic-template-v1", content: "Synthetic prompt text." },
        ],
      },
    ]);
    const result = await resolveDependencyFingerprint(
      { metadata: { read } } as unknown as Connection,
      fingerprint.targets,
    );
    expect(result.dependencies.map((item) => item.name)).toEqual([
      "AnswerSearch",
      "AnswerFlow",
      "ChildFlow",
      "AnswerTemplate",
    ]);
    expect(read).toHaveBeenCalledWith("GenAiPromptTemplate", ["AnswerTemplate"]);
    expect(result.dependencies.find((item) => item.kind === "apex")).toHaveProperty("body_sha256");
    expect(JSON.stringify(result)).not.toContain("public class");
    expect(JSON.stringify(result)).not.toContain("Synthetic prompt text.");
  });
  it("fails closed when a dependency cannot be resolved", async () => {
    query.mockResolvedValue(null);
    await expect(
      resolveDependencyFingerprint({} as Connection, fingerprint.targets),
    ).rejects.toThrow("AnswerFlow");
  });
  it("refuses unresolved active template identifiers", async () => {
    const conn = { metadata: { read: vi.fn().mockResolvedValue([{}]) } } as unknown as Connection;
    await expect(
      resolveDependencyFingerprint(conn, [
        { scheme: "generatePromptResponse", ref_name: "AnswerTemplate" },
      ]),
    ).rejects.toThrow("AnswerTemplate");
  });
  it("fails closed on transitive Flow cycles", async () => {
    query.mockImplementation(async () => [
      {
        Id: "synthetic-flow",
        VersionNumber: 1,
        Metadata: { subflows: [{ flowName: "AnswerFlow" }] },
      },
    ]);
    await expect(
      resolveDependencyFingerprint({} as Connection, fingerprint.targets),
    ).rejects.toThrow("cycle at flow:AnswerFlow");
  });
  it("bounds transitive traversal to depth five", async () => {
    query.mockImplementation(async (_conn, _endpoint, soql: string) => {
      const depth = Number(/'Flow(\d+)'/.exec(soql)?.[1]);
      return [
        {
          Id: `synthetic-flow-${depth}`,
          VersionNumber: 1,
          Metadata: { subflows: [{ flowName: `Flow${depth + 1}` }] },
        },
      ];
    });
    await expect(
      resolveDependencyFingerprint({} as Connection, [{ scheme: "flow", ref_name: "Flow0" }]),
    ).rejects.toThrow("depth exceeds five at flow:Flow6");
  });
  it("hashes prompt content even when the active identifier is reused", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        activeVersionIdentifier: "v1",
        templateVersions: [{ versionIdentifier: "v1", content: "Original." }],
      })
      .mockResolvedValueOnce({
        activeVersionIdentifier: "v1",
        templateVersions: [{ versionIdentifier: "v1", content: "Edited." }],
      });
    const conn = { metadata: { read } } as unknown as Connection;
    const targets = [{ scheme: "generatePromptResponse", ref_name: "AnswerTemplate" }];
    const original = await resolveDependencyFingerprint(conn, targets);
    const edited = await resolveDependencyFingerprint(conn, targets);
    expect(compareDependencyFingerprints(original, edited)).toEqual([
      expect.stringContaining("prompt_template 'AnswerTemplate' content_sha256:"),
    ]);
  });
  it("resolves a template whose single version the Metadata API returns as an object", async () => {
    const read = vi.fn().mockResolvedValue({
      activeVersionIdentifier: "v1",
      templateVersions: { versionIdentifier: "v1", content: "Only version." },
    });
    const conn = { metadata: { read } } as unknown as Connection;
    const result = await resolveDependencyFingerprint(conn, [
      { scheme: "generatePromptResponse", ref_name: "AnswerTemplate" },
    ]);
    expect(result.dependencies).toEqual([
      expect.objectContaining({ kind: "prompt_template", active_version_identifier: "v1" }),
    ]);
  });
  it("names prompt templates when the metadata transport fails", async () => {
    const conn = {
      metadata: { read: vi.fn().mockRejectedValue(new Error("Request failed")) },
    } as unknown as Connection;
    await expect(
      resolveDependencyFingerprint(conn, [
        { scheme: "generatePromptResponse", ref_name: "AnswerTemplate" },
      ]),
    ).rejects.toThrow("Prompt template 'AnswerTemplate' lookup failed: Request failed");
  });
  it("allows exactly five transitive edges", async () => {
    query.mockImplementation(async (_conn, _endpoint, soql: string) => {
      const depth = Number(/'Flow(\d+)'/.exec(soql)?.[1]);
      return [
        {
          Id: `synthetic-flow-${depth}`,
          VersionNumber: 1,
          Metadata: { subflows: depth < 5 ? [{ flowName: `Flow${depth + 1}` }] : [] },
        },
      ];
    });
    const result = await resolveDependencyFingerprint({} as Connection, [
      { scheme: "flow", ref_name: "Flow0" },
    ]);
    expect(result.dependencies).toHaveLength(6);
  });
  it("names dependencies added and removed through a changed Flow graph", () => {
    const withoutApex = {
      ...fingerprint,
      dependencies: fingerprint.dependencies.filter((item) => item.kind !== "apex"),
    };
    expect(compareDependencyFingerprints(fingerprint, withoutApex)).toEqual([
      "apex 'AnswerSearch' removed",
    ]);
    expect(compareDependencyFingerprints(withoutApex, fingerprint)).toEqual([
      "apex 'AnswerSearch' added",
    ]);
  });
});
