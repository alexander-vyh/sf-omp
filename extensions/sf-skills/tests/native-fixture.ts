/* SPDX-License-Identifier: Apache-2.0 */
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Production settings deliberately refuse global writes outside this checkout. */
export function nativeTestDir(prefix: string): string {
  const root = fileURLToPath(new URL("../../../.runtime/skill-tests/", import.meta.url));
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, prefix));
}
