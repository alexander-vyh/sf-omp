/* SPDX-License-Identifier: Apache-2.0 */
/** Behavior tests for authentication-only Pi providers and their OMP adapter. */
import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore, createModels } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAuthOnlyProvider,
  createOmpAuthOnlyOAuth,
  registerAuthOnlyProvider,
  resolveAuthOnlyProviderAuth,
} from "../auth-only-provider.ts";
import { toPiCredential } from "../pi-auth-status.ts";
import {
  createSecureCredentialPromptBridge,
  loginWithSecureCredentialPrompt,
} from "../secure-credential-prompt.ts";

const apiKeyAuth = {
  name: "Fixture token",
  login: async () => ({ type: "api_key" as const, key: "fixture-private" }),
  resolve: async ({ credential }: { credential?: { key?: string } }) =>
    credential?.key
      ? { auth: { apiKey: credential.key }, source: "Pi saved credential" }
      : undefined,
};

function ompCallbacks(answers: string[]) {
  return {
    onAuth: vi.fn(),
    onProgress: vi.fn(),
    onPrompt: vi.fn(async () => answers.shift() ?? ""),
    signal: new AbortController().signal,
  };
}

describe("createAuthOnlyProvider", () => {
  it("participates in Pi login, auth resolution, and logout without exposing models", async () => {
    const provider = createAuthOnlyProvider({
      id: "fixture-auth",
      name: "Fixture Auth",
      auth: { apiKey: apiKeyAuth },
    });
    const credentials = new InMemoryCredentialStore();
    const models = createModels({ credentials });
    models.setProvider(provider);

    expect(provider.getModels()).toEqual([]);
    await expect(
      models.login("fixture-auth", "api_key", { prompt: vi.fn(), notify: vi.fn() }),
    ).resolves.toMatchObject({ type: "api_key", key: "fixture-private" });
    await expect(models.getAuth("fixture-auth")).resolves.toMatchObject({
      auth: { apiKey: "fixture-private" },
      source: "Pi saved credential",
    });

    await models.logout("fixture-auth");
    await expect(models.getAuth("fixture-auth")).resolves.toBeUndefined();
  });
});

describe("registerAuthOnlyProvider", () => {
  it("registers the Pi Provider object on the Pi host", () => {
    const registerProvider = vi.fn();
    const provider = createAuthOnlyProvider({
      id: "fixture-auth",
      name: "Fixture Auth",
      auth: { apiKey: apiKeyAuth },
    });
    registerAuthOnlyProvider({ registerProvider } as unknown as ExtensionAPI, provider);
    expect(registerProvider).toHaveBeenCalledWith(provider);
  });

  it("delegates request-auth resolution to Pi's provider registry", async () => {
    const getProviderAuth = vi.fn(async () => ({ auth: { apiKey: "k" }, source: "s" }));
    await expect(
      resolveAuthOnlyProviderAuth({ modelRegistry: { getProviderAuth } } as never, "fixture"),
    ).resolves.toEqual({ auth: { apiKey: "k" }, source: "s" });
    expect(getProviderAuth).toHaveBeenCalledWith("fixture");
  });
});

describe("createOmpAuthOnlyOAuth", () => {
  it("stores Pi API-key credentials with env as a pinned, non-expiring OMP record", async () => {
    const oauth = createOmpAuthOnlyOAuth({
      id: "fixture-docs",
      name: "Fixture Docs",
      auth: {
        apiKey: {
          name: "Fixture token",
          login: async (interaction) => {
            const endpoint = await interaction.prompt({ type: "text", message: "Endpoint" });
            const region = await interaction.prompt({
              type: "select",
              message: "Region",
              options: [
                { id: "us", label: "US" },
                { id: "eu", label: "EU" },
              ],
            });
            const key = await interaction.prompt({ type: "secret", message: "Token" });
            interaction.notify({ type: "info", message: "Saved." });
            return { type: "api_key", key, env: { ENDPOINT: endpoint, REGION: region } };
          },
          resolve: async () => undefined,
        },
      },
    });
    const callbacks = ompCallbacks(["https://docs.example.test/", "2", "fixture-private"]);

    const stored = await oauth.login(callbacks);

    expect(oauth.name).toBe("Fixture Docs");
    expect(callbacks.onPrompt.mock.calls.map(([prompt]) => prompt)).toEqual([
      { message: "Endpoint", placeholder: undefined, allowEmpty: true },
      expect.objectContaining({
        message: expect.stringContaining("1) US\n2) EU"),
        allowEmpty: true,
      }),
      { message: "Token", placeholder: undefined, secret: true },
    ]);
    expect(callbacks.onProgress).toHaveBeenCalledWith("Saved.");
    expect(stored).toEqual({
      access: "fixture-private",
      refresh: "",
      expires: 253_402_300_799_000,
      accountId: "fixture-docs",
      sfPiCredential: "api_key",
      env: { ENDPOINT: "https://docs.example.test/", REGION: "eu" },
    });
    expect(oauth.getApiKey(stored)).toBe("fixture-private");
    await expect(oauth.refreshToken(stored)).resolves.toBe(stored);
    expect(toPiCredential({ type: "oauth", ...stored })).toEqual({
      type: "api_key",
      key: "fixture-private",
      env: { ENDPOINT: "https://docs.example.test/", REGION: "eu" },
    });
  });

  it("keeps Pi OAuth fields, refreshes through Pi, and offers a method choice", async () => {
    const refresh = vi.fn(async (credential: { access: string }) => ({
      ...credential,
      type: "oauth" as const,
      access: "fixture-access-2",
      expires: 2,
    }));
    const oauth = createOmpAuthOnlyOAuth({
      id: "fixture-slack",
      name: "Fixture Slack",
      auth: {
        apiKey: apiKeyAuth,
        oauth: {
          name: "Fixture OAuth",
          login: async (interaction) => {
            interaction.notify({ type: "auth_url", url: "https://auth.example.test/" });
            return {
              type: "oauth",
              access: "fixture-access",
              refresh: "fixture-refresh",
              expires: 1,
              accountId: "team-1",
              team: "T1",
            };
          },
          refresh,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
    });
    const callbacks = ompCallbacks([""]);

    const stored = await oauth.login(callbacks);

    expect(callbacks.onPrompt.mock.calls[0]?.[0].message).toContain("1) Fixture OAuth");
    expect(callbacks.onAuth).toHaveBeenCalledWith({
      url: "https://auth.example.test/",
      instructions: undefined,
    });
    expect(stored).toMatchObject({
      access: "fixture-access",
      accountId: "fixture-slack",
      sfPiAccountId: "team-1",
      sfPiCredential: "oauth",
      team: "T1",
    });
    expect(toPiCredential({ type: "oauth", ...stored })).toEqual({
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: 1,
      accountId: "team-1",
      team: "T1",
    });

    const refreshed = await oauth.refreshToken(stored);
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({ type: "oauth", accountId: "team-1", access: "fixture-access" }),
      expect.any(AbortSignal),
    );
    expect(refreshed).toMatchObject({
      access: "fixture-access-2",
      accountId: "fixture-slack",
      sfPiCredential: "oauth",
    });
  });

  it("uses the host-masked secret prompt instead of SF Pi's TUI component", async () => {
    const bridge = createSecureCredentialPromptBridge({ title: "Fixture credential" });
    const oauth = createOmpAuthOnlyOAuth({
      id: "fixture-fin",
      name: "Fixture Fin",
      auth: {
        apiKey: {
          name: "Fixture token",
          login: (interaction) => loginWithSecureCredentialPrompt(bridge, interaction),
          resolve: async () => undefined,
        },
      },
    });
    const callbacks = ompCallbacks(["fixture-private"]);

    await expect(oauth.login(callbacks)).resolves.toMatchObject({ access: "fixture-private" });
    expect(callbacks.onPrompt).toHaveBeenCalledWith({
      message: "Fixture credential",
      placeholder: undefined,
      secret: true,
    });
  });

  it("rejects unknown select answers", async () => {
    const oauth = createOmpAuthOnlyOAuth({
      id: "fixture",
      name: "Fixture",
      auth: {
        apiKey: {
          name: "Fixture token",
          login: async (interaction) => ({
            type: "api_key",
            key: await interaction.prompt({
              type: "select",
              message: "Pick",
              options: [{ id: "a", label: "A" }],
            }),
          }),
          resolve: async () => undefined,
        },
      },
    });
    await expect(oauth.login(ompCallbacks(["z"]))).rejects.toThrow('Unknown choice "z".');
    await expect(oauth.login(ompCallbacks(["a"]))).resolves.toMatchObject({ access: "a" });
  });
});
