/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Status-only OMP auth-store inspection.
 *
 * Execution paths should use `ctx.modelRegistry.getApiKeyForProvider()` or
 * `resolveAuthOnlyProviderAuth()` so the host owns credential retrieval. These
 * helpers exist for config/status surfaces that do not receive an
 * ExtensionContext. Status helpers report only whether a provider appears
 * configured; they never return token values.
 *
 * OMP keeps credentials in its agent database, where SF Pi auth-only providers
 * store an OAuth-shaped record (see `auth-only-provider.ts`);
 * `readPiAuthCredential()` reads it back in Pi's credential shape.
 */
import type { Credential } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

export interface PiAuthProviderStatus {
  provider: string;
  configured: boolean;
}

/**
 * Marker on OMP-stored records written by SF Pi auth-only providers: which Pi
 * credential type the OAuth-shaped OMP record carries.
 */
export const SF_PI_CREDENTIAL_KIND = "sfPiCredential";
/** Original Pi `accountId` of an OAuth credential; OMP's `accountId` pins the row identity. */
export const SF_PI_ACCOUNT_ID = "sfPiAccountId";

/** Fields read from a host-stored credential row; values are unverified until checked. */
type StoredHostCredential = { [field: string]: unknown };

function apiKeyCredential(key: unknown, env: unknown): Credential {
  return {
    type: "api_key",
    ...(typeof key === "string" && key ? { key } : {}),
    ...(env && typeof env === "object" && !Array.isArray(env)
      ? { env: env as Record<string, string> }
      : {}),
  };
}

/**
 * Convert one OMP-stored credential into Pi's credential shape. API-key rows
 * pass through; OAuth-shaped rows written by SF Pi auth-only providers are
 * unwrapped.
 */
export function toPiCredential(value: unknown): Credential | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const stored = value as StoredHostCredential;
  if (stored.type === "api_key") return apiKeyCredential(stored.key, stored.env);
  if (stored.type !== "oauth") return undefined;
  const kind = stored[SF_PI_CREDENTIAL_KIND];
  if (kind === "api_key") return apiKeyCredential(stored.access, stored.env);
  if (kind !== "oauth") return stored as unknown as Credential;
  const {
    [SF_PI_CREDENTIAL_KIND]: _kind,
    [SF_PI_ACCOUNT_ID]: accountId,
    accountId: _pinned,
    ...rest
  } = stored;
  return { ...rest, ...(accountId !== undefined ? { accountId } : {}) } as unknown as Credential;
}

/**
 * Read one provider's OMP-stored credential in Pi's shape. Status and
 * login-time checks only.
 */
export function readPiAuthCredential(provider: string): Credential | undefined {
  // OMP's compatibility shim reads the first active credential from its agent
  // database; the row is OMP-shaped until `toPiCredential()` checks it.
  const readOmpCredential: (id: string) => unknown = readStoredCredential;
  return toPiCredential(readOmpCredential(provider));
}

export function readPiAuthProviderStatus(provider: string): PiAuthProviderStatus {
  return { provider, configured: readPiAuthCredential(provider) !== undefined };
}

/** Report whether a provider has a non-empty stored API key without returning it. */
export function hasPiAuthProviderApiKey(provider: string): boolean {
  const credential = readPiAuthCredential(provider);
  if (credential?.type !== "api_key") return false;
  return typeof credential.key === "string" && Boolean(credential.key.trim());
}

/**
 * Read one named non-secret `credential.env` value from the OMP auth store.
 * Never returns `key`, `access`, or `refresh`.
 */
export function readPiAuthProviderEnv(provider: string, envName: string): string | undefined {
  const credential = readPiAuthCredential(provider);
  if (credential?.type !== "api_key") return undefined;
  const value = credential.env?.[envName];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
