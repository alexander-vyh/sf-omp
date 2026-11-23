/* SPDX-License-Identifier: Apache-2.0 */
/** Version evidence for mutable metadata invoked by a released BotVersion. */
import { createHash } from "node:crypto";
import type { Connection } from "@salesforce/core";
import { boundedPromise } from "./bounded-salesforce-transport.ts";
import { inspectFile } from "./inspect.ts";
import { extractActionTargets } from "./preflight/parse.ts";
import { safeQueryRecords, soqlInList } from "./preflight/soql.ts";

export interface ReleaseDependencyTarget {
  scheme: "flow" | "apex" | "apexRest" | "generatePromptResponse";
  ref_name: string;
}
export type ReleaseDependency =
  | {
      kind: "prompt_template";
      name: string;
      active_version_identifier: string;
      content_sha256: string;
    }
  | { kind: "flow"; name: string; active_version_id: string; version_number: number }
  | { kind: "apex"; name: string; id: string; last_modified_date: string; body_sha256: string };
export interface DependencyFingerprint {
  schema_version: 1;
  targets: ReleaseDependencyTarget[];
  dependencies: ReleaseDependency[];
}

/** Absence is never equivalent to an empty, successfully resolved dependency set. */
export function compareDependencyFingerprints(
  recorded: DependencyFingerprint | undefined,
  current: DependencyFingerprint | undefined,
): string[] {
  if (
    !recorded ||
    recorded.schema_version !== 1 ||
    !Array.isArray(recorded.dependencies) ||
    !Array.isArray(recorded.targets)
  ) {
    return ["no dependency fingerprint, rerun required"];
  }
  if (
    !current ||
    current.schema_version !== 1 ||
    !Array.isArray(current.dependencies) ||
    !Array.isArray(current.targets)
  ) {
    return ["current dependency fingerprint unavailable, rerun required"];
  }
  const key = (item: ReleaseDependency) => `${item.kind} '${item.name}'`;
  const before = new Map(recorded.dependencies.map((item) => [key(item), item]));
  const after = new Map(current.dependencies.map((item) => [key(item), item]));
  const differences: string[] = [];
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(name);
    const next = after.get(name);
    if (!old) differences.push(`${name} added`);
    else if (!next) differences.push(`${name} removed`);
    else {
      const fields = Object.keys(old).filter((field) => field !== "kind" && field !== "name");
      for (const field of fields) {
        const oldValue = (old as unknown as Record<string, unknown>)[field];
        const nextValue = (next as unknown as Record<string, unknown>)[field];
        if (oldValue !== nextValue)
          differences.push(`${name} ${field}: ${String(oldValue)} -> ${String(nextValue)}`);
      }
    }
  }
  const targetKey = (target: ReleaseDependencyTarget) => `${target.scheme}://${target.ref_name}`;
  if (
    recorded.targets.map(targetKey).sort().join("\n") !==
    current.targets.map(targetKey).sort().join("\n")
  ) {
    differences.push("invoked dependency targets changed");
  }
  return differences;
}

export async function fingerprintAgentFile(
  conn: Connection,
  agentFile: string,
): Promise<DependencyFingerprint> {
  const inspected = await inspectFile(agentFile);
  if (!inspected.ok || inspected.has_parse_errors || !inspected.components) {
    throw new Error(
      "Cannot resolve release dependencies from an unreadable or invalid Agent Script.",
    );
  }
  return resolveDependencyFingerprint(conn, extractActionTargets(inspected.components.actions));
}

/** Re-resolve the recorded roots, including active Flow subflows/actions, to depth five. */
export async function resolveDependencyFingerprint(
  conn: Connection,
  roots: readonly { scheme: string; ref_name: string }[],
): Promise<DependencyFingerprint> {
  const supported = ["flow", "apex", "apexRest", "generatePromptResponse"];
  const targets = [
    ...new Map(
      roots
        .filter((item) => supported.includes(item.scheme))
        .map((item) => [
          `${item.scheme}://${item.ref_name}`,
          { scheme: item.scheme, ref_name: item.ref_name } as ReleaseDependencyTarget,
        ]),
    ).values(),
  ].sort((a, b) => `${a.scheme}://${a.ref_name}`.localeCompare(`${b.scheme}://${b.ref_name}`));
  const dependencies = new Map<string, ReleaseDependency>();
  const visiting = new Set<string>();
  const visit = async (target: ReleaseDependencyTarget, depth: number): Promise<void> => {
    const kind =
      target.scheme === "flow"
        ? "flow"
        : target.scheme === "generatePromptResponse"
          ? "prompt_template"
          : "apex";
    const key = `${kind}:${target.ref_name}`;
    if (dependencies.has(key)) return;
    if (visiting.has(key)) throw new Error(`Release dependency cycle at ${key}.`);
    if (depth > 5) throw new Error(`Release dependency depth exceeds five at ${key}.`);
    visiting.add(key);
    const name = target.ref_name;
    if (kind === "prompt_template") {
      // GenAiPromptTemplate is Metadata API metadata. Installed Tooling types describe
      // Prompt/PromptVersion as in-app guidance, so they are not used here.
      const metadata = conn.metadata as unknown as {
        read(type: string, names: string[]): Promise<unknown>;
      };
      let result: unknown;
      try {
        result = await boundedPromise(
          metadata.read("GenAiPromptTemplate", [name]),
          `Prompt template '${name}' lookup`,
        );
      } catch (error) {
        throw new Error(
          `Prompt template '${name}' lookup failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const row = (Array.isArray(result) ? result[0] : result) as
        | {
            activeVersionIdentifier?: unknown;
            templateVersions?:
              | Array<{ versionIdentifier?: string; content?: string }>
              | { versionIdentifier?: string; content?: string };
          }
        | undefined;
      if (typeof row?.activeVersionIdentifier !== "string" || !row.activeVersionIdentifier) {
        throw new Error(`Prompt template '${name}' has no resolvable active version identifier.`);
      }
      // Metadata API read returns a lone <templateVersions> element as an object, not a one-item array.
      const versions = Array.isArray(row.templateVersions)
        ? row.templateVersions
        : row.templateVersions
          ? [row.templateVersions]
          : [];
      const active = versions.filter(
        (version) => version.versionIdentifier === row.activeVersionIdentifier,
      );
      if (active?.length !== 1 || typeof active[0].content !== "string") {
        throw new Error(`Prompt template '${name}' active version content could not be resolved.`);
      }
      dependencies.set(key, {
        kind,
        name,
        active_version_identifier: row.activeVersionIdentifier,
        content_sha256: createHash("sha256").update(active[0].content).digest("hex"),
      });
    } else if (kind === "apex") {
      const rows = await safeQueryRecords<{
        Id?: string;
        LastModifiedDate?: string;
        Body?: string;
      }>(
        conn,
        "/tooling/query",
        `SELECT Id, LastModifiedDate, Body FROM ApexClass WHERE Name IN (${soqlInList([name])})`,
      );
      const row = rows?.length === 1 ? rows[0] : undefined;
      if (!row?.Id || !row.LastModifiedDate || typeof row.Body !== "string")
        throw new Error(`Apex '${name}' version could not be resolved.`);
      dependencies.set(key, {
        kind,
        name,
        id: row.Id,
        last_modified_date: row.LastModifiedDate,
        body_sha256: createHash("sha256").update(row.Body).digest("hex"),
      });
    } else {
      const rows = await safeQueryRecords<{
        Id?: string;
        VersionNumber?: number;
        Metadata?: {
          subflows?: Array<{ flowName?: string }>;
          actionCalls?: Array<{ actionType?: string; actionName?: string }>;
        };
      }>(
        conn,
        "/tooling/query",
        `SELECT Id, VersionNumber, Metadata FROM Flow WHERE Definition.DeveloperName IN (${soqlInList([name])}) AND Status = 'Active' LIMIT 1`,
      );
      const row = rows?.[0];
      if (!row?.Id || typeof row.VersionNumber !== "number" || !row.Metadata)
        throw new Error(`Flow '${name}' active version could not be resolved.`);
      const children: ReleaseDependencyTarget[] = [];
      for (const subflow of row.Metadata.subflows ?? []) {
        if (!subflow.flowName) throw new Error(`Flow '${name}' has an unresolved subflow.`);
        children.push({ scheme: "flow", ref_name: subflow.flowName });
      }
      for (const action of row.Metadata.actionCalls ?? []) {
        if (
          action.actionType !== "apex" &&
          action.actionType !== "generatePromptResponse" &&
          action.actionType !== "flow"
        )
          continue;
        if (!action.actionName)
          throw new Error(`Flow '${name}' has an unresolved ${action.actionType} action.`);
        children.push({ scheme: action.actionType, ref_name: action.actionName });
      }
      for (const child of children) await visit(child, depth + 1);
      dependencies.set(key, {
        kind,
        name,
        active_version_id: row.Id,
        version_number: row.VersionNumber,
      });
    }
    visiting.delete(key);
  };
  for (const target of targets) await visit(target, 0);
  return {
    schema_version: 1,
    targets,
    dependencies: [...dependencies.values()].sort((a, b) =>
      `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`),
    ),
  };
}
