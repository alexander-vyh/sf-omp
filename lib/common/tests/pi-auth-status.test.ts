/* SPDX-License-Identifier: Apache-2.0 */
/** Status reads over OMP's agent-database credential rows. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasPiAuthProviderApiKey,
  readPiAuthProviderEnv,
  readPiAuthProviderStatus,
  SF_PI_CREDENTIAL_KIND,
} from "../pi-auth-status.ts";

// OMP's compatibility shim returns a provider's first active credential row.
const ompRows = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@earendil-works/pi-coding-agent", () => ({
  readStoredCredential: (provider: string) => ompRows.get(provider),
}));

/** Row an SF Pi auth-only provider stores for a Pi API-key login. */
function sfPiApiKeyRow(key: string, env?: Record<string, string>) {
  return {
    type: "oauth",
    access: key,
    refresh: "",
    expires: 253_402_300_799_000,
    accountId: "sf-docs",
    [SF_PI_CREDENTIAL_KIND]: "api_key",
    ...(env ? { env } : {}),
  };
}

const sfPiOAuthRow = {
  type: "oauth",
  access: "secret-token",
  refresh: "secret-refresh",
  expires: Date.now(),
  accountId: "sf-docs",
  [SF_PI_CREDENTIAL_KIND]: "oauth",
};

beforeEach(() => ompRows.clear());

describe("readPiAuthProviderStatus", () => {
  it("detects OMP-stored API-key and OAuth credentials without returning values", () => {
    for (const row of [
      { type: "api_key", key: "secret-key" },
      sfPiApiKeyRow("secret-key"),
      sfPiOAuthRow,
    ]) {
      ompRows.set("sf-docs", row);

      expect(readPiAuthProviderStatus("sf-docs")).toEqual({
        provider: "sf-docs",
        configured: true,
      });
    }
  });

  it("reports missing or unrecognized credential rows as unconfigured", () => {
    expect(readPiAuthProviderStatus("sf-docs")).toEqual({
      provider: "sf-docs",
      configured: false,
    });

    ompRows.set("sf-docs", { type: "session-cookie", value: "secret" });
    expect(readPiAuthProviderStatus("sf-docs")).toMatchObject({ configured: false });
  });

  it("distinguishes API-key credentials from endpoint-only and OAuth entries", () => {
    ompRows.set("sf-docs", sfPiApiKeyRow("secret-key"));
    expect(hasPiAuthProviderApiKey("sf-docs")).toBe(true);

    ompRows.set(
      "sf-docs",
      sfPiApiKeyRow("", { SF_DOCS_MCP_ENDPOINT: "https://docs.example.test/" }),
    );
    expect(hasPiAuthProviderApiKey("sf-docs")).toBe(false);

    ompRows.set("sf-docs", sfPiOAuthRow);
    expect(hasPiAuthProviderApiKey("sf-docs")).toBe(false);
  });

  it("reads a named credential env value without returning secrets", () => {
    const secret = "sfmcp-must-not-return";
    ompRows.set(
      "sf-docs",
      sfPiApiKeyRow(secret, { SF_DOCS_MCP_ENDPOINT: "https://docs.example.test/" }),
    );

    expect(readPiAuthProviderEnv("sf-docs", "SF_DOCS_MCP_ENDPOINT")).toBe(
      "https://docs.example.test/",
    );
    expect(readPiAuthProviderEnv("sf-docs", "key")).toBeUndefined();
  });
});
