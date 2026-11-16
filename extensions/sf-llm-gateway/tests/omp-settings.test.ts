/* SPDX-License-Identifier: Apache-2.0 */
/** Behavior proofs for projecting Gateway model selection into OMP config. */
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { projectModelSelectionToOmpConfig } from "../lib/omp-settings.ts";

describe("projectModelSelectionToOmpConfig", () => {
  it("writes the default model role and model scope, keeping other keys and comments", () => {
    const source = "# user config\ntheme: dark\nmodelRoles:\n  smol: openai/gpt-4o-mini\n";

    const next = projectModelSelectionToOmpConfig(source, {
      defaultProvider: "sf-llm-gateway",
      defaultModel: "claude-sonnet-4-5",
      enabledModels: ["sf-llm-gateway/*"],
      sfPi: { compaction: { model: "active" } },
    });

    expect(next).toContain("# user config");
    expect(parse(next)).toEqual({
      theme: "dark",
      modelRoles: { smol: "openai/gpt-4o-mini", default: "sf-llm-gateway/claude-sonnet-4-5" },
      enabledModels: ["sf-llm-gateway/*"],
    });
  });

  it("clears only Gateway-owned scope and default when Pi settings drop them", () => {
    const source =
      "enabledModels:\n  - sf-llm-gateway/*\nmodelRoles:\n  default: sf-llm-gateway/claude-sonnet-4-5\n";

    const next = projectModelSelectionToOmpConfig(source, {
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
    });

    expect(parse(next)).toEqual({ modelRoles: { default: "openai/gpt-4o-mini" } });
  });

  it("never clears a user's own OMP default or model scope", () => {
    const source = "enabledModels:\n  - openai/*\nmodelRoles:\n  default: openai/gpt-4o-mini\n";

    expect(parse(projectModelSelectionToOmpConfig(source, {}))).toEqual(parse(source));
  });

  it("leaves an empty config empty when nothing is selected", () => {
    expect(projectModelSelectionToOmpConfig("", {})).toBe("");
  });
});
