/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  applyGatewayGpt6ResponseStyle,
  GATEWAY_GPT6_RESPONSE_STYLE_SECTION,
} from "../lib/response-style.ts";

describe("Gateway GPT-6 response style", () => {
  const model = { provider: "sf-llm-gateway", id: "gpt-6-sol" };

  it("returns one native policy block without mutating other guidance", () => {
    const original = ["Keep existing guidance."];
    const result = applyGatewayGpt6ResponseStyle(original, model);
    expect(original).toEqual(["Keep existing guidance."]);
    expect(result[0]).toBe(original[0]);
    expect(result[1]).toContain(`<${GATEWAY_GPT6_RESPONSE_STYLE_SECTION}>`);
    expect(result[1]).toContain("substantive questions");
    expect(result[1]).toContain("concrete example");
    expect(result[1]).toContain("relevant trade-offs");
    expect(result[1]).toContain("explicit requests for brevity");
  });

  it("does not duplicate its policy block on repeated preparation", () => {
    const first = applyGatewayGpt6ResponseStyle(["Other policy."], model);
    expect(applyGatewayGpt6ResponseStyle(first, model)).toEqual(first);
  });

  it.each([
    { provider: "sf-llm-gateway", id: "gpt-5.6-sol" },
    { provider: "openai", id: "gpt-6-sol" },
    { provider: "sf-llm-gateway", id: "gpt-6-luna" },
    undefined,
  ])("removes only its own block on model switch: %o", (nextModel) => {
    const first = applyGatewayGpt6ResponseStyle(["Other policy."], model);
    expect(applyGatewayGpt6ResponseStyle(first, nextModel)).toEqual(["Other policy."]);
  });
});
