/* SPDX-License-Identifier: Apache-2.0 */
/** Unit tests for shared sf-pi extension enablement helpers (native OMP config). */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  filterEnabledExtensionStatuses,
  getDisabledExtensionFilesForCwd,
  isSfPiExtensionEnabled,
} from "../sf-pi-extension-state.ts";

/** Project-scope OMP config (`<cwd>/.omp/config.yml`) disabling the given bundled extensions. */
function makeCwd(disabledIds: string[]): string {
  const cwd = mkdtempSync(join(tmpdir(), "sf-pi-extension-state-"));
  mkdirSync(join(cwd, ".omp"), { recursive: true });
  writeFileSync(
    join(cwd, ".omp", "config.yml"),
    `disabledExtensions:\n${disabledIds.map((id) => `  - extension-module:${id}\n`).join("")}`,
  );
  return cwd;
}

describe("sf-pi extension state", () => {
  it("reads disabled bundled extensions from the project OMP config", () => {
    const cwd = makeCwd(["sf-slack"]);

    expect(getDisabledExtensionFilesForCwd(cwd)).toEqual(new Set(["extensions/sf-slack/index.ts"]));
    expect(isSfPiExtensionEnabled(cwd, "sf-slack")).toBe(false);
    expect(isSfPiExtensionEnabled(cwd, "sf-data360")).toBe(true);
    expect(isSfPiExtensionEnabled(cwd, "sf-welcome")).toBe(true);
  });

  it("never reports always-active extensions as disabled", () => {
    const cwd = makeCwd(["sf-pi-manager"]);

    expect(getDisabledExtensionFilesForCwd(cwd)).toEqual(new Set());
    expect(isSfPiExtensionEnabled(cwd, "sf-pi-manager")).toBe(true);
  });

  it("filters footer statuses by owning extension enablement", () => {
    const cwd = makeCwd(["sf-slack"]);
    const statuses = new Map([
      ["sf-slack-status", "Slack ✓ Connected"],
      ["sf-llm-gateway", "$1/∞"],
      ["sf-pi", "SF Pi Packages: 10/12 extensions"],
      ["unknown", "should not render"],
    ]);

    const filtered = filterEnabledExtensionStatuses(cwd, statuses);

    expect(filtered.has("sf-slack-status")).toBe(false);
    expect(filtered.get("sf-llm-gateway")).toBe("$1/∞");
    expect(filtered.get("sf-pi")).toBe("SF Pi Packages: 10/12 extensions");
    expect(filtered.has("unknown")).toBe(false);
  });
});
