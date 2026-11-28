/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Resolve the sf-pi package root for runtime asset lookups.
 *
 * sf-omp is loaded explicitly from its checkout (`-e <checkout>`), so the root
 * is found with a bounded walk up from this module to the directory holding
 * both `package.json` and `catalog/`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SfPiPackageRootResolution {
  packageRoot?: string;
  source: "module-walk" | "missing";
}

export function resolveSfPiPackageRoot(options: { from?: string } = {}): SfPiPackageRootResolution {
  const walked = resolvePackageRootFromModule(options.from ?? import.meta.url);
  if (walked) {
    return { packageRoot: walked, source: "module-walk" };
  }

  return { source: "missing" };
}

export function resolveSfPiPackageRootPath(options: { from?: string } = {}): string | undefined {
  return resolveSfPiPackageRoot(options).packageRoot;
}

function resolvePackageRootFromModule(from: string): string | undefined {
  try {
    let current = path.dirname(fileURLToPath(from));
    for (let i = 0; i < 10; i += 1) {
      if (
        existsSync(path.join(current, "package.json")) &&
        existsSync(path.join(current, "catalog"))
      ) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch {
    // Fall through to undefined.
  }
  return undefined;
}
