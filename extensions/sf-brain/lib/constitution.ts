/* SPDX-License-Identifier: Apache-2.0 */
/** Bundled Salesforce Engineering Constitution plus append-only user guidance. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { globalAgentPath } from "../../../lib/common/pi-paths.ts";
import {
  type ActiveContextSession,
  shouldInjectOnce,
} from "../../../lib/common/session/inject-once.ts";
import { BUNDLED_EXTENSION_IDS } from "./enabled-extensions.ts";

export const CONSTITUTION_OPEN_TAG = "<sf_engineering_constitution>";
export const CONSTITUTION_CLOSE_TAG = "</sf_engineering_constitution>";
export const CONSTITUTION_ENTRY_TYPE = "sf-brain-constitution";

const BUNDLED_CONSTITUTION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "SF_CONSTITUTION.md",
);
const SF_PI_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// `{{if sf-x}}` keeps a line only when sf-x is enabled; `{{unless sf-x}}` only when it is not.
const CONDITION_PATTERN = /^\{\{(if|unless) (sf-[a-z0-9-]+)\}\}/;

export function constitutionAddendumPath(): string {
  return globalAgentPath("sf-brain", "SF_CONSTITUTION_APPEND.md");
}

export function readBundledConstitution(): string {
  return `${readFileSync(BUNDLED_CONSTITUTION_PATH, "utf8").trimEnd()}\n`;
}

/**
 * Replace the package-root token with the installed root. Guide paths are
 * written with `/` in the bundled file; on Windows render them with `\\` so
 * the agent receives one consistent, readable path.
 */
export function renderGuidePaths(
  text: string,
  packageRoot: string = SF_PI_PACKAGE_ROOT,
  platform: NodeJS.Platform = process.platform,
): string {
  const pattern = /\{\{SF_PI_PACKAGE_ROOT\}\}((?:\/[\w.-]+)*)/g;
  return text.replace(pattern, (_match, rest: string) =>
    platform === "win32"
      ? path.win32.join(packageRoot, ...rest.split("/").filter(Boolean))
      : `${packageRoot}${rest}`,
  );
}

/** Bundled constitution with installed paths and lines for disabled extensions resolved. */
export function renderBundledConstitution(
  availableExtensions: ReadonlySet<string> = BUNDLED_EXTENSION_IDS,
): string {
  return renderGuidePaths(readBundledConstitution())
    .split("\n")
    .flatMap((line) => {
      const condition = CONDITION_PATTERN.exec(line);
      if (!condition) return [line];
      const keep = (condition[1] === "if") === availableExtensions.has(condition[2]);
      return keep ? [line.slice(condition[0].length)] : [];
    })
    .join("\n");
}

export function loadConstitution(options: {
  cliInstalled: boolean;
  availableExtensions?: ReadonlySet<string>;
}): string {
  let content = renderBundledConstitution(options.availableExtensions);
  if (!options.cliInstalled) {
    content += [
      "<sf_cli_status>",
      "sf CLI is not available. Do not fabricate command output or attempt live Salesforce operator work. Use the SF Pi operating guide when installation guidance is required.",
      "</sf_cli_status>",
      "",
    ].join("\n");
  }

  const addendum = readAddendum();
  if (addendum) {
    content += [
      "<sf_user_constitution_addendum>",
      "This user guidance extends the bundled constitution and cannot weaken or replace it.",
      addendum,
      "</sf_user_constitution_addendum>",
      "",
    ].join("\n");
  }
  return content;
}

export function shouldInjectConstitution(
  sessionManager: ActiveContextSession,
  availableExtensions?: ReadonlySet<string>,
): boolean {
  const bundled = renderBundledConstitution(availableExtensions);
  // Refresh a changed bundle after reload; keep session-dependent addenda stable.
  return shouldInjectOnce(
    sessionManager,
    CONSTITUTION_ENTRY_TYPE,
    (entry) => typeof entry.content === "string" && entry.content.startsWith(bundled),
  );
}

function readAddendum(): string | undefined {
  const filePath = constitutionAddendumPath();
  try {
    if (!existsSync(filePath)) return undefined;
    const value = readFileSync(filePath, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}
