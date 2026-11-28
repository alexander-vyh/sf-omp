/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pi-compat — host runtime helpers for the native OMP host.
 *
 * sf-omp runs only inside native OMP, whose Pi compatibility module serves the
 * `@earendil-works/pi-coding-agent` import. This module reports the host
 * version, compares versions, and gates each bundled extension's factory on
 * the SF Pi Manager's OMP-native enablement state.
 */
import * as PiRuntime from "@earendil-works/pi-coding-agent";
import { isExtensionDisabledInOmpConfig } from "./sf-pi-extension-state.ts";

/** Cached host version; stable for the life of the OMP process. */
let cachedPiVersion: string | undefined | null = null;

/** Native OMP version, from the compatibility module's `VERSION` export. */
export function getInstalledPiVersion(): string | undefined {
  if (cachedPiVersion !== null) return cachedPiVersion;
  const version: unknown = PiRuntime.VERSION;
  cachedPiVersion = typeof version === "string" && version.trim() ? version.trim() : undefined;
  return cachedPiVersion;
}

/**
 * Compare semver-ish versions (`x.y.z` or `x.y.z-tag`). Build metadata is
 * ignored and prereleases sort below the matching full release.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const [withoutBuild = v] = v.split("+", 1);
    const [core, pre = ""] = withoutBuild.split("-", 2);
    const nums = core.split(".").map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
    while (nums.length < 3) nums.push(0);
    return { nums, pre };
  };

  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/**
 * Gate each extension factory on the SF Pi Manager's OMP-native enablement.
 * OMP's explicit-only launch skips native `disabledExtensions`, so honour the
 * manager's `extension-module:<id>` entries here (next OMP start).
 */
export function requirePiVersion(_pi: unknown, extensionName: string): boolean {
  return !isExtensionDisabledInOmpConfig(extensionName);
}
