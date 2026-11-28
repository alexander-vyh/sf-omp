/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Tests for recommendations manifest loading.
 *
 * Covers: loadRecommendationsManifest
 *
 * Loader is tolerant: malformed input \u2192 empty manifest. That keeps the
 * manager extension safe against a bad catalog file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRecommendationsManifest } from "../../../lib/common/catalog-state/recommendations-manifest.ts";

let pkgRoot: string;

function seedManifest(contents: unknown): void {
  mkdirSync(path.join(pkgRoot, "catalog"), { recursive: true });
  writeFileSync(
    path.join(pkgRoot, "catalog", "recommendations.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf8",
  );
}

beforeEach(() => {
  pkgRoot = mkdtempSync(path.join(tmpdir(), "sf-pi-rec-manifest-"));
});

afterEach(() => {
  rmSync(pkgRoot, { recursive: true, force: true });
});

describe("loadRecommendationsManifest", () => {
  it("returns empty manifest when file is missing", () => {
    const m = loadRecommendationsManifest(pkgRoot);
    expect(m.revision).toBe("");
    expect(m.items).toEqual({});
    expect(m.bundles).toEqual([]);
  });

  it("returns empty manifest on invalid JSON", () => {
    seedManifest("nope");
    const m = loadRecommendationsManifest(pkgRoot);
    expect(m.revision).toBe("");
  });

  it("returns empty manifest when schemaVersion is not 1", () => {
    seedManifest({ schemaVersion: 2, revision: "r", bundles: [], items: {} });
    const m = loadRecommendationsManifest(pkgRoot);
    expect(m.revision).toBe("");
  });

  it("loads a valid manifest", () => {
    seedManifest({
      schemaVersion: 1,
      revision: "r1",
      bundles: [
        { id: "default", name: "Default", description: "", defaultOnFirstRun: true, items: ["a"] },
      ],
      items: {
        a: {
          id: "a",
          name: "A",
          description: "d",
          source: "git:example.com/a",
          homepage: "https://example.com/a",
          license: "MIT",
          rationale: "why",
        },
      },
    });
    const m = loadRecommendationsManifest(pkgRoot);
    expect(m.revision).toBe("r1");
    expect(Object.keys(m.items)).toEqual(["a"]);
    expect(m.bundles).toHaveLength(1);
  });
});
