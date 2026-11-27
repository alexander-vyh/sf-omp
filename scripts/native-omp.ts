/* SPDX-License-Identifier: Apache-2.0 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Find the user's executable, ignoring project launchers and the pinned proof CLI. */
export function findNativeOmp(
  root: string,
  searchPath = process.env.PATH ?? "",
): { executable: string; searchPath: string } | undefined {
  const launcher = resolvedIfPresent(path.join(root, "tools", "bin", "omp"));
  const pinned = resolvedIfPresent(
    path.join(root, "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"),
  );
  let executable: string | undefined;
  const entries: string[] = [];
  for (const directory of searchPath.split(path.delimiter)) {
    const candidate = path.resolve(directory, "omp");
    try {
      const target = realpathSync(candidate);
      if (target === launcher || target === pinned) continue;
      if (!executable && statSync(target).isFile()) {
        accessSync(candidate, constants.X_OK);
        executable = candidate;
      }
    } catch {
      // Missing and non-executable entries cannot supply the native command.
    }
    entries.push(directory);
  }
  return executable ? { executable, searchPath: entries.join(path.delimiter) } : undefined;
}

function resolvedIfPresent(filename: string): string | undefined {
  try {
    return realpathSync(filename);
  } catch {
    return undefined;
  }
}
