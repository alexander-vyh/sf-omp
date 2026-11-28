/* SPDX-License-Identifier: Apache-2.0 */
/** Behavior tests for authentication-only providers and their OMP adapter. */
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

// OMP's compatibility shim returns a provider's first active credential row.
const ompRows = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readStoredCredential: (provider: string) => ompRows.get(provider),
}));

const apiKeyAuth = {
  name: "Fixture token",
  login: async () => ({ type: "api_key" as const, key: "fixture-private" }),
  resolve: async ({ credential }: { credential?: { key?: string } }) =>
    credential?.key
      ? { auth: { apiKey: credential.key }, source: "OMP saved credential" }
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
      source: "OMP saved credential",
    });

    await models.logout("fixture-auth");
    await expect(models.getAuth("fixture-auth")).resolves.toBeUndefined();
  });
});

describe("registerAuthOnlyProvider", () => {
  it("registers one OMP OAuth login through the host-bound registerProvider", () => {
    const calls: Array<{ host: unknown; name: string; config: unknown }> = [];
    const pi = {
      registerProvider(this: unknown, name: string, config: unknown) {
        calls.push({ host: this, name, config });
      },
    };

    registerAuthOnlyProvider(pi as unknown as ExtensionAPI, {
      id: "fixture-auth",
      name: "Fixture Auth",
      auth: { apiKey: apiKeyAuth },
    });

    expect(calls).toEqual([
      {
        host: pi,
        name: "fixture-auth",
        config: { oauth: expect.objectContaining({ name: "Fixture Auth" }) },
      },
    ]);
  });
});

describe("resolveAuthOnlyProviderAuth", () => {
  it("resolves request auth from the credential OMP stored at login", async () => {
    const registerProvider = vi.fn();
    registerAuthOnlyProvider({ registerProvider } as unknown as ExtensionAPI, {
      id: "fixture-resolve",
      name: "Fixture Resolve",
      auth: { apiKey: apiKeyAuth },
    });
    const ctx = { modelRegistry: { getApiKeyForProvider: vi.fn() } } as never;

    await expect(resolveAuthOnlyProviderAuth(ctx, "fixture-unregistered")).resolves.toBeUndefined();
    await expect(resolveAuthOnlyProviderAuth(ctx, "fixture-resolve")).resolves.toBeUndefined();

    const oauth = createOmpAuthOnlyOAuth({
      id: "fixture-resolve",
      name: "Fixture Resolve",
      auth: { apiKey: apiKeyAuth },
    });
    ompRows.set("fixture-resolve", { type: "oauth", ...(await oauth.login(ompCallbacks([]))) });

    await expect(resolveAuthOnlyProviderAuth(ctx, "fixture-resolve")).resolves.toEqual({
      auth: { apiKey: "fixture-private" },
      source: "OMP saved credential",
    });
    expect(registerProvider).toHaveBeenCalledOnce();
  });

  it("refreshes an expiring OAuth credential through OMP before toAuth()", async () => {
    const toAuth = vi.fn(async (credential: { access: string }) => ({ apiKey: credential.access }));
    registerAuthOnlyProvider({ registerProvider: vi.fn() } as unknown as ExtensionAPI, {
      id: "fixture-refresh",
      name: "Fixture Refresh",
      auth: { oauth: { name: "Fixture OAuth", login: vi.fn(), refresh: vi.fn(), toAuth } },
    });
    const stored = {
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      accountId: "fixture-refresh",
      sfPiCredential: "oauth",
    };
    ompRows.set("fixture-refresh", { ...stored, expires: Date.now() - 1 });
    // OMP's locked refresh rewrites the stored row before returning the key.
    const getApiKeyForProvider = vi.fn(async (provider: string) => {
      ompRows.set(provider, {
        ...stored,
        access: "fixture-access-2",
        expires: Date.now() + 3_600_000,
      });
      return "fixture-access-2";
    });

    await expect(
      resolveAuthOnlyProviderAuth(
        { modelRegistry: { getApiKeyForProvider } } as never,
        "fixture-refresh",
      ),
    ).resolves.toEqual({ auth: { apiKey: "fixture-access-2" }, source: "OAuth" });
    expect(getApiKeyForProvider).toHaveBeenCalledWith("fixture-refresh");
    expect(toAuth).toHaveBeenCalledWith(
      expect.objectContaining({ type: "oauth", access: "fixture-access-2" }),
    );
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
