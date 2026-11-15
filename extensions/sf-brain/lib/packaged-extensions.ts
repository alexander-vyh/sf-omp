/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Extension ids loaded from this package's root manifest (`package.json` `pi.extensions`).
 *
 * The OMP launcher loads only that list, and this checkout keeps unported
 * upstream extensions in the source tree, so the catalog registry is not the
 * set of capabilities the model can actually use.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_JSON_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../package.json",
);
const ENTRY_PATTERN = /^\.\/extensions\/([^/]+)\/index\.ts$/;

let cached: ReadonlySet<string> | undefined;

export function packagedExtensionIds(): ReadonlySet<string> {
  if (cached) return cached;
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
    pi?: { extensions?: unknown };
  };
  const entries = Array.isArray(pkg.pi?.extensions) ? pkg.pi.extensions : [];
  cached = new Set(
    entries.flatMap((entry) => {
      const match = typeof entry === "string" ? ENTRY_PATTERN.exec(entry) : null;
      return match ? [match[1]] : [];
    }),
  );
  return cached;
}
