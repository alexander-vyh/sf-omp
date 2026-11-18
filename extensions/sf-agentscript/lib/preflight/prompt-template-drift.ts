/* SPDX-License-Identifier: Apache-2.0 */
/** Advisory-only local/org active prompt-content comparison for check_targets. */
import type { Connection } from "@salesforce/core";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { ComponentSummary } from "../inspect.ts";
import { resolveDependencyFingerprint } from "../release-dependencies.ts";
import { extractActionTargets } from "./parse.ts";

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_PACKAGE_DIRECTORIES = 100;

export interface PromptTemplateDriftFinding {
  name: string;
  detail: string;
}

export interface PromptTemplateDriftResult {
  warnings: PromptTemplateDriftFinding[];
  unverifiable: PromptTemplateDriftFinding[];
}

/** Local-first, with one bounded Metadata API lookup per unique locally sourced target. */
export async function checkPromptTemplateDrift(
  conn: Connection,
  actions: readonly ComponentSummary[],
  agentFile: string,
): Promise<PromptTemplateDriftResult> {
  const result: PromptTemplateDriftResult = { warnings: [], unverifiable: [] };
  const names = [
    ...new Set(
      extractActionTargets(actions)
        .filter((target) => target.scheme === "generatePromptResponse")
        .map((target) => target.ref_name),
    ),
  ];
  if (names.length === 0) return result;
  let directories: string[];
  try {
    directories = await templateDirectories(agentFile);
  } catch {
    result.unverifiable = names.map((name) => ({
      name,
      detail:
        "Prompt template drift could not be checked: local project configuration is unreadable or exceeds discovery limits.",
    }));
    return result;
  }
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false,
    isArray: (tagName) => tagName === "templateVersions",
  });
  for (const name of names) {
    try {
      // Names are metadata fullNames, never paths supplied to filesystem traversal.
      if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Invalid template name");
      const sources: string[] = [];
      for (const directory of directories) {
        const source = await boundedSource(
          path.join(directory, `${name}.genAiPromptTemplate-meta.xml`),
        );
        if (source !== undefined) sources.push(source);
      }
      if (sources.length === 0) continue;
      if (sources.length !== 1 || XMLValidator.validate(sources[0]) !== true) {
        throw new Error("Ambiguous or malformed local source");
      }
      const row = parser.parse(sources[0]).GenAiPromptTemplate as
        | {
            activeVersionIdentifier?: string;
            templateVersions?: Array<{ versionIdentifier?: string; content?: string }>;
          }
        | undefined;
      const identifier = row?.activeVersionIdentifier;
      const active = row?.templateVersions?.filter(
        (version) => version.versionIdentifier === identifier,
      );
      if (!identifier || active?.length !== 1 || typeof active[0].content !== "string") {
        throw new Error("Unresolved local active version");
      }
      // Keep the release-contract Metadata API reader as the sole org authority.
      const fingerprint = await resolveDependencyFingerprint(conn, [
        { scheme: "generatePromptResponse", ref_name: name },
      ]);
      const org = fingerprint.dependencies.find(
        (item) => item.kind === "prompt_template" && item.name === name,
      );
      if (!org || org.kind !== "prompt_template") throw new Error("Unresolved org active version");
      // Match release-dependencies.ts: SHA-256 of the decoded content, without trimming.
      const localHash = createHash("sha256").update(active[0].content).digest("hex");
      if (identifier === org.active_version_identifier && localHash !== org.content_sha256) {
        result.warnings.push({
          name,
          detail: `Prompt Template '${name}': content differs but active version unchanged. Bump the versionIdentifier and matching activeVersionIdentifier, or check the deployment/activation path (including enableEinsteinGPTDeployPromptTemplatesAsActive).`,
        });
      }
    } catch {
      result.unverifiable.push({
        name,
        detail: `Prompt Template '${name}': content drift is unverifiable; local source must have one active version and the org Metadata API active content must be readable.`,
      });
    }
  }
  return result;
}

async function boundedSource(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES)
      throw new Error("Source exceeds read limit");
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function templateDirectories(agentFile: string): Promise<string[]> {
  let current = path.dirname(path.resolve(agentFile));
  while (true) {
    const source = await boundedSource(path.join(current, "sfdx-project.json"));
    if (source !== undefined) {
      const project = JSON.parse(source) as { packageDirectories?: Array<{ path?: string }> };
      const packages = project.packageDirectories;
      if (!Array.isArray(packages) || packages.length > MAX_PACKAGE_DIRECTORIES) {
        throw new Error("Invalid package directories");
      }
      const directories = new Set<string>();
      for (const pkg of packages) {
        if (typeof pkg?.path !== "string" || !pkg.path) throw new Error("Invalid package path");
        const root = path.resolve(current, pkg.path);
        directories.add(path.join(root, "main", "default", "genAiPromptTemplates"));
        directories.add(path.join(root, "genAiPromptTemplates"));
      }
      return [...directories];
    }
    const parent = path.dirname(current);
    if (parent === current) return [];
    current = parent;
  }
}
