/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ModelRegistry members that differ between Pi and OMP.
 *
 * Pi exposes provider auth status, provider auth resolution, provider-scoped
 * refresh, and a credential-applying `streamSimple` on its registry. OMP's
 * registry instead resolves provider keys directly, refreshes extension
 * providers through its runtime discovery pass, and leaves dispatch to the
 * pi-ai stream entry point. Detect by member, never by version.
 */
import {
  contentText,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { hostStreamSimpleDispatch, lazyStream } from "./host-compat.ts";

export type OmpModelRefreshStrategy = "online" | "offline" | "online-if-uncached";

/** The OMP ModelRegistry members this extension relies on. */
export interface OmpModelRegistry {
  getAll(): Model<Api>[];
  getApiKey(model: Model<Api>): Promise<string | undefined>;
  getApiKeyForProvider(provider: string): Promise<string | undefined>;
  hasConcreteAuth(provider: string): boolean;
  refreshRuntimeProviders(strategy?: OmpModelRefreshStrategy): Promise<void>;
}

export interface GatewayProviderAuthStatus {
  configured: boolean;
  label?: string;
  source?: string;
}

/** Return the registry as OMP's when it carries OMP's provider-key members. */
export function asOmpModelRegistry(registry: unknown): OmpModelRegistry | undefined {
  if (!registry || typeof registry !== "object") return undefined;
  if (!("getApiKeyForProvider" in registry) || typeof registry.getApiKeyForProvider !== "function")
    return undefined;
  if (
    !("refreshRuntimeProviders" in registry) ||
    typeof registry.refreshRuntimeProviders !== "function"
  )
    return undefined;
  if (!("hasConcreteAuth" in registry) || typeof registry.hasConcreteAuth !== "function")
    return undefined;
  // Member checks above prove the OMP-only surface; TypeScript cannot narrow a class from `in`.
  const omp = registry as OmpModelRegistry;
  return omp;
}

/** Provider credential readiness without resolving or exposing the credential itself. */
export function getProviderAuthStatus(
  registry: ModelRegistry,
  provider: string,
): GatewayProviderAuthStatus {
  const omp = asOmpModelRegistry(registry);
  if (omp) {
    return omp.hasConcreteAuth(provider)
      ? { configured: true, source: "OMP provider credential" }
      : { configured: false };
  }
  return registry.getProviderAuthStatus(provider);
}

/** OMP transports take `{ systemPrompt, tools, messages }`, not a leading system message. */
function toHostContext(context: TranscriptContext): Context {
  const [first, ...rest] = context.messages;
  if (first?.role !== "system") return { messages: [...context.messages] } as Context;
  return {
    systemPrompt: contentText(first.content),
    ...(first.toolsAdded ? { tools: [...first.toolsAdded] } : {}),
    messages: rest,
  } as Context;
}

/** Stream a registry model with its provider credential applied. */
export function streamWithRegistryAuth(
  registry: Pick<ModelRegistry, "streamSimple">,
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const omp = asOmpModelRegistry(registry);
  if (!omp) return registry.streamSimple(model, context, options);
  // OMP dispatches custom provider APIs through pi-ai; credential lookup is the caller's.
  return lazyStream(
    model,
    async () =>
      hostStreamSimpleDispatch(model, toHostContext(context), {
        ...options,
        apiKey: options?.apiKey ?? (await omp.getApiKey(model)),
      }),
    undefined,
    options?.signal,
  );
}

/** A `find` + credentialed `streamSimple` view of either host's registry. */
export function credentialedRegistry(registry: ModelRegistry): {
  find(provider: string, modelId: string): Model<Api> | undefined;
  streamSimple(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
} {
  return {
    find: (provider, modelId) => registry.find(provider, modelId),
    streamSimple: (model, context, options) =>
      streamWithRegistryAuth(registry, model, context, options),
  };
}
