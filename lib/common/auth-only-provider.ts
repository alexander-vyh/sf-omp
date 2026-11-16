/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Authentication-only providers: own `/login` credentials, expose no models.
 *
 * Pi registers a `Provider` object whose `auth` drives `/login`. OMP registers
 * `registerProvider(name, { oauth })` instead, and its `/login` persists either
 * a plain API key or OAuth-shaped credentials in its agent database. On OMP the
 * Pi `ProviderAuth` is adapted to one OMP OAuth login:
 *
 * - Pi API-key credentials (`{ key, env }`) are stored as an OAuth-shaped record
 *   (`access` = key, `env` kept, never expires) so non-secret provider env such
 *   as endpoints and regions survives; `refresh` is a no-op.
 * - Pi OAuth credentials keep every field; OMP refresh calls the Pi refresh.
 * - `accountId` is pinned to the provider id so a new login replaces the
 *   stored row instead of adding a second pooled credential.
 *
 * `readPiAuthCredential()` (pi-auth-status.ts) reads either host store back in
 * Pi's shape, and `resolveAuthOnlyProviderAuth()` resolves request auth like
 * Pi's `modelRegistry.getProviderAuth()` on both hosts.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  ApiKeyCredential,
  AuthContext,
  AuthEvent,
  AuthPrompt,
  AuthResult,
  OAuthCredential,
  Provider,
  ProviderAuth,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isOmpHost } from "./pi-compat.ts";
import { readPiAuthCredential, SF_PI_ACCOUNT_ID, SF_PI_CREDENTIAL_KIND } from "./pi-auth-status.ts";

export interface AuthOnlyProviderInput {
  id: string;
  name: string;
  auth: ProviderAuth;
}

/** Build a Pi Provider that owns authentication but exposes no models. */
export function createAuthOnlyProvider(input: AuthOnlyProviderInput): Provider {
  const unavailable = (): never => {
    throw new Error(`Authentication-only provider ${input.id} cannot stream model requests.`);
  };

  return {
    id: input.id,
    name: input.name,
    auth: input.auth,
    getModels: () => [],
    stream: unavailable,
    streamSimple: unavailable,
  };
}

// --- OMP host contract (structural; OMP's ProviderConfig["oauth"]) ----------

interface OmpOAuthPrompt {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
  secret?: boolean;
}

interface OmpOAuthLoginCallbacks {
  onAuth(info: { url: string; launchUrl?: string; instructions?: string }): void;
  onProgress?(message: string): void;
  onManualCodeInput?(signal?: AbortSignal): Promise<string>;
  onPrompt(prompt: OmpOAuthPrompt): Promise<string>;
  signal?: AbortSignal;
}

export interface OmpOAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  [field: string]: unknown;
}

export interface OmpAuthOnlyOAuth {
  name: string;
  login(callbacks: OmpOAuthLoginCallbacks): Promise<OmpOAuthCredentials>;
  refreshToken(credentials: OmpOAuthCredentials): Promise<OmpOAuthCredentials>;
  getApiKey(credentials: OmpOAuthCredentials): string;
}

type OmpRegisterProvider = (name: string, config: { oauth: OmpAuthOnlyOAuth }) => void;

/** Latest valid JavaScript date (9999-12-31): stored API keys never expire. */
const API_KEY_EXPIRES = 253_402_300_799_000;

/** Interactions built by the OMP adapter: the host masks `secret` prompts natively. */
const HOST_MASKED_SECRETS = Symbol.for("sf-pi.auth.host-masked-secrets");

/**
 * True when `prompt({ type: "secret" })` is masked by the host's own login UI
 * (OMP). Pi's stock secret prompt is visible, so Pi providers use SF Pi's
 * session-bound masked input instead.
 */
export function hostMasksSecretPrompts(interaction: unknown): boolean {
  return (
    !!interaction &&
    typeof interaction === "object" &&
    HOST_MASKED_SECRETS in interaction &&
    interaction[HOST_MASKED_SECRETS] === true
  );
}

/** Pi auth registered on OMP, by provider id, for `resolveAuthOnlyProviderAuth()`. */
const ompProviderAuth = new Map<string, ProviderAuth>();

/**
 * Register an authentication-only provider on the active host so `/login <id>`
 * stores its credential and `/logout <id>` removes it.
 *
 * @example
 * registerAuthOnlyProvider(pi, { id: "sf-docs", name: "SF Docs", auth: { apiKey } });
 * // execution path:
 * const resolved = await resolveAuthOnlyProviderAuth(ctx, "sf-docs");
 * // status path (no ctx):
 * const credential = readPiAuthCredential("sf-docs");
 */
export function registerAuthOnlyProvider(
  pi: ExtensionAPI,
  input: AuthOnlyProviderInput | Provider,
): void {
  if (!isOmpHost(pi)) {
    pi.registerProvider("getModels" in input ? input : createAuthOnlyProvider(input));
    return;
  }
  ompProviderAuth.set(input.id, input.auth);
  // Pi's type declares `registerProvider(provider)`; the OMP host method is
  // `registerProvider(name, config)` and reads `this`, so call it bound.
  const registerOmpProvider = pi.registerProvider as unknown as OmpRegisterProvider;
  registerOmpProvider.call(pi, input.id, { oauth: createOmpAuthOnlyOAuth(input) });
}

/** OMP `ProviderConfig.oauth` adapter for one Pi `ProviderAuth`. Exported for tests. */
export function createOmpAuthOnlyOAuth(input: AuthOnlyProviderInput): OmpAuthOnlyOAuth {
  const { id, auth } = input;
  if (!auth.apiKey?.login && !auth.oauth) {
    throw new Error(`Authentication-only provider ${id} has no login method.`);
  }
  return {
    name: input.name,
    login: async (callbacks) => {
      const interaction = createOmpInteraction(callbacks);
      const method = await chooseLoginMethod(input, interaction);
      if (method === "oauth" && auth.oauth) {
        return toOmpOAuthCredential(id, await auth.oauth.login(interaction));
      }
      const apiKeyLogin = auth.apiKey?.login;
      if (!apiKeyLogin) throw new Error(`Provider ${id} has no API-key login.`);
      return toOmpApiKeyCredential(id, await apiKeyLogin(interaction));
    },
    refreshToken: async (credentials) => {
      if (credentials[SF_PI_CREDENTIAL_KIND] !== "oauth" || !auth.oauth) return credentials;
      const current = readOmpOAuthCredential(credentials);
      const refreshed = await auth.oauth.refresh(current, new AbortController().signal);
      return toOmpOAuthCredential(id, refreshed);
    },
    getApiKey: (credentials) => credentials.access,
  };
}

async function chooseLoginMethod(
  input: AuthOnlyProviderInput,
  interaction: ProviderAuthInteraction,
): Promise<"apiKey" | "oauth"> {
  const { apiKey, oauth } = input.auth;
  if (!oauth) return "apiKey";
  if (!apiKey?.login) return "oauth";
  return (await interaction.prompt({
    type: "select",
    message: `${input.name} sign-in method`,
    options: [
      { id: "oauth", label: oauth.loginLabel ?? oauth.name },
      { id: "apiKey", label: apiKey.name },
    ],
  })) as "apiKey" | "oauth";
}

function toOmpApiKeyCredential(id: string, credential: ApiKeyCredential): OmpOAuthCredentials {
  return {
    access: credential.key ?? "",
    refresh: "",
    expires: API_KEY_EXPIRES,
    accountId: id,
    [SF_PI_CREDENTIAL_KIND]: "api_key",
    ...(credential.env ? { env: credential.env } : {}),
  };
}

function toOmpOAuthCredential(id: string, credential: OAuthCredential): OmpOAuthCredentials {
  const { type: _type, accountId, ...rest } = credential;
  return {
    ...rest,
    accountId: id,
    [SF_PI_CREDENTIAL_KIND]: "oauth",
    ...(accountId !== undefined ? { [SF_PI_ACCOUNT_ID]: accountId } : {}),
  };
}

function readOmpOAuthCredential(credentials: OmpOAuthCredentials): OAuthCredential {
  const {
    [SF_PI_CREDENTIAL_KIND]: _kind,
    [SF_PI_ACCOUNT_ID]: accountId,
    accountId: _pinned,
    ...rest
  } = credentials;
  return { ...rest, type: "oauth", ...(accountId !== undefined ? { accountId } : {}) };
}

/** Pi `AuthInteraction` over OMP's login callbacks. */
function createOmpInteraction(callbacks: OmpOAuthLoginCallbacks): ProviderAuthInteraction {
  return {
    [HOST_MASKED_SECRETS]: true,
    signal: callbacks.signal ?? new AbortController().signal,
    prompt: (prompt) => promptOnOmp(callbacks, prompt),
    notify: (event) => notifyOnOmp(callbacks, event),
  } as ProviderAuthInteraction;
}

async function promptOnOmp(callbacks: OmpOAuthLoginCallbacks, prompt: AuthPrompt): Promise<string> {
  prompt.signal?.throwIfAborted();
  switch (prompt.type) {
    case "text":
      return callbacks.onPrompt({
        message: prompt.message,
        placeholder: prompt.placeholder,
        allowEmpty: true,
      });
    case "secret":
      return callbacks.onPrompt({
        message: prompt.message,
        placeholder: prompt.placeholder,
        secret: true,
      });
    case "manual_code":
      return callbacks.onManualCodeInput
        ? callbacks.onManualCodeInput(prompt.signal)
        : callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
    case "select": {
      // OMP login prompts are free text: list the choices and accept a number,
      // id, or label. Empty input keeps the first (current/default) choice.
      const lines = prompt.options.map(
        (option, index) =>
          `${index + 1}) ${option.label}${option.description ? ` — ${option.description}` : ""}`,
      );
      const answer = (
        await callbacks.onPrompt({
          message: `${prompt.message}\n${lines.join("\n")}\nEnter a number (Enter keeps 1)`,
          placeholder: "1",
          allowEmpty: true,
        })
      ).trim();
      const chosen = selectOption(prompt.options, answer);
      if (!chosen) throw new Error(`Unknown choice "${answer}".`);
      return chosen.id;
    }
  }
}

function selectOption(
  options: readonly { id: string; label: string }[],
  answer: string,
): { id: string } | undefined {
  if (!answer) return options[0];
  if (/^\d+$/u.test(answer)) return options[Number(answer) - 1];
  const lowered = answer.toLowerCase();
  return options.find(
    (option) => option.id.toLowerCase() === lowered || option.label.toLowerCase() === lowered,
  );
}

function notifyOnOmp(callbacks: OmpOAuthLoginCallbacks, event: AuthEvent): void {
  switch (event.type) {
    case "auth_url":
      callbacks.onAuth({ url: event.url, instructions: event.instructions });
      return;
    case "device_code":
      callbacks.onAuth({
        url: event.verificationUri,
        instructions: `Enter code ${event.userCode}`,
      });
      return;
    case "info": {
      const links = (event.links ?? []).map((link) =>
        link.label ? `${link.label}: ${link.url}` : link.url,
      );
      callbacks.onProgress?.([event.message, ...links].join("\n"));
      return;
    }
    case "progress":
      callbacks.onProgress?.(event.message);
  }
}

// --- Request-auth read-back --------------------------------------------------

const hostAuthContext: AuthContext = {
  env: async (name) => process.env[name],
  fileExists: async (file) =>
    existsSync(file.startsWith("~") ? path.join(homedir(), file.slice(1)) : file),
};

type PiProviderAuthRegistry = {
  getProviderAuth?: (provider: string) => Promise<AuthResult | undefined>;
  getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
};

/** Refresh OAuth this long before expiry, matching the host refresh window. */
const OAUTH_REFRESH_SKEW_MS = 5 * 60_000;

/**
 * Resolve request auth (`apiKey`/`baseUrl`/`headers`, provider env, source)
 * for an authentication-only provider, like Pi's
 * `ctx.modelRegistry.getProviderAuth()`: stored credential first, then the
 * provider's ambient fallbacks. Returns undefined when not configured.
 * On OMP, expiring OAuth credentials are refreshed through OMP's locked
 * credential refresh before `toAuth()`.
 */
export async function resolveAuthOnlyProviderAuth(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  providerId: string,
): Promise<AuthResult | undefined> {
  const registry = ctx.modelRegistry as unknown as PiProviderAuthRegistry;
  if (typeof registry.getProviderAuth === "function") {
    return registry.getProviderAuth.call(ctx.modelRegistry, providerId);
  }
  const auth = ompProviderAuth.get(providerId);
  if (!auth) return undefined;
  let credential = readPiAuthCredential(providerId);
  if (credential?.type === "oauth" && auth.oauth) {
    if (
      credential.expires - OAUTH_REFRESH_SKEW_MS <= Date.now() &&
      typeof registry.getApiKeyForProvider === "function"
    ) {
      await registry.getApiKeyForProvider.call(ctx.modelRegistry, providerId);
      credential = readPiAuthCredential(providerId);
      if (credential?.type !== "oauth") return undefined;
    }
    return { auth: await auth.oauth.toAuth(credential), source: "OAuth" };
  }
  if (!auth.apiKey) return undefined;
  return auth.apiKey.resolve({
    ctx: hostAuthContext,
    credential: credential?.type === "api_key" ? credential : undefined,
    signal: new AbortController().signal,
  });
}
