/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Tests for `/sf-pi recommended` argument parsing and its sf-omp behavior.
 *
 * Covers: parseRecommendedArgs, handleRecommended
 *
 * Nothing installable loads under the explicit-only sf-omp launcher, so the
 * command lists every item as unsupported with its OMP coverage and refuses
 * install/remove without running an installer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleRecommended, parseRecommendedArgs } from "../lib/recommendations.ts";

// -------------------------------------------------------------------------------------------------
// parseRecommendedArgs
// -------------------------------------------------------------------------------------------------

describe("parseRecommendedArgs", () => {
  it("lists for an empty tail, list, status, and unknown subcommands", () => {
    expect(parseRecommendedArgs("")).toEqual({ subcommand: "list" });
    expect(parseRecommendedArgs("   ")).toEqual({ subcommand: "list" });
    expect(parseRecommendedArgs("list project")).toEqual({ subcommand: "list" });
    expect(parseRecommendedArgs("status")).toEqual({ subcommand: "list" });
    expect(parseRecommendedArgs("bogus")).toEqual({ subcommand: "list" });
  });

  it("routes install and the remove aliases case-insensitively", () => {
    expect(parseRecommendedArgs("install pi-web-access project")).toEqual({
      subcommand: "install",
    });
    expect(parseRecommendedArgs("INSTALL")).toEqual({ subcommand: "install" });
    expect(parseRecommendedArgs("remove pi-web-access")).toEqual({ subcommand: "remove" });
    expect(parseRecommendedArgs("rm pi-web-access")).toEqual({ subcommand: "remove" });
    expect(parseRecommendedArgs("uninstall pi-web-access")).toEqual({ subcommand: "remove" });
  });
});

// -------------------------------------------------------------------------------------------------
// handleRecommended
// -------------------------------------------------------------------------------------------------

describe("handleRecommended", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function packageRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), "sf-pi-recommended-"));
    tempDirs.push(root);
    mkdirSync(path.join(root, "catalog"), { recursive: true });
    const item = (id: string, source: string) => ({
      id,
      name: id,
      description: "d",
      source,
      homepage: `https://example.com/${id}`,
      license: "MIT",
      rationale: "why",
    });
    writeFileSync(
      path.join(root, "catalog", "recommendations.json"),
      JSON.stringify({
        schemaVersion: 1,
        revision: "r1",
        bundles: [],
        items: {
          "pi-web-access": item("pi-web-access", "npm:pi-web-access"),
          helper: item("helper", "git:example.com/helper"),
        },
      }),
    );
    return root;
  }

  function run(subcommand: "list" | "install" | "remove") {
    const notify = vi.fn();
    handleRecommended({ ui: { notify } } as never, packageRoot(), { subcommand });
    expect(notify).toHaveBeenCalledOnce();
    return notify.mock.calls[0] as [string, string];
  }

  it("lists every item as unsupported with its OMP coverage", () => {
    const [text, level] = run("list");

    expect(level).toBe("info");
    expect(text).toContain("Recommended extensions (OMP host): 2 unsupported");
    expect(text).toContain("explicit-only");
    expect(text).toContain("✗ pi-web-access (npm:pi-web-access)");
    expect(text).toContain("Under OMP: OMP's native web search and fetch tools.");
    expect(text).toContain("✗ helper (git:example.com/helper)");
    expect(text).toContain("Under OMP: No OMP-native equivalent; not available under sf-omp.");
  });

  it("refuses install and remove with the explicit-only reason", () => {
    for (const subcommand of ["install", "remove"] as const) {
      const [text, level] = run(subcommand);

      expect(level).toBe("warning");
      expect(text).toMatch(
        new RegExp(
          `^/sf-pi recommended ${subcommand} is not supported under sf-omp\\. sf-omp launches OMP explicit-only`,
        ),
      );
      expect(text).toContain("Recommended extensions (OMP host): 2 unsupported");
    }
  });
});
