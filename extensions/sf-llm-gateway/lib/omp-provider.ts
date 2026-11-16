/* SPDX-License-Identifier: Apache-2.0 */
/**
 * OMP provider registration for the SF LLM Gateway.
 *
 * OMP registers extension providers by config (`registerProvider(name, config)`)
 * and reserves built-in API names, so each real Gateway API gets one custom API
 * whose stream relabels the model to its real API and reuses the same guarded,
 * endpoint-routed adapters as Pi. Discovery runs through OMP's dynamic model
 * cache; `/login sf-llm-gateway` stores the key in OMP's credential store and
 * the non-secret root URL in extension config.
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { API_KEY_ENV, PROVIDER_NAME } from "./config.ts";
import { getHostCatalogModels, lazyStream } from "./host-compat.ts";
import type { GatewayApi } from "./models.ts";
import { GATEWAY_RESOLVED_ROOT_ENV, type OmpLoginCallbacks } from "./provider-auth.ts";
import type { GatewayProviderRuntime } from "./provider.ts";

/** OMP custom API identifier per real Gateway API (built-in names are reserved). */
export const OMP_GATEWAY_APIS = {
  "anthropic-messages": "sf-llm-gateway-anthropic-messages",
  "openai-completions": "sf-llm-gateway-openai-completions",
  "openai-responses": "sf-llm-gateway-openai-responses",
} as const satisfies Record<GatewayApi, string>;

const DISCOVERY_TIMEOUT_MS = 15_000;
const UNCONFIGURED_ERROR = `Provider is not configured: ${PROVIDER_NAME}`;

/** One OMP dynamic model row. */
export interface OmpGatewayModelConfig {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  thinking?: unknown;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: Model<Api>["compat"];
}

/** The subset of OMP's `ProviderConfig` this extension registers. */
export interface OmpGatewayProviderConfig {
  api?: string;
  apiKey?: string;
  streamSimple?: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
  oauth?: { name: string; login(callbacks: OmpLoginCallbacks): Promise<string> };
  fetchDynamicModels?: (apiKey: string | undefined) => Promise<readonly OmpGatewayModelConfig[]>;
}

/** OMP's `ExtensionAPI.registerProvider(name, config)` shape. */
export interface OmpProviderHost {
  registerProvider(name: string, config: OmpGatewayProviderConfig): void;
}

export interface OmpGatewayProviderOptions {
  /** Bounded replacement for a recognized Gateway error, or undefined to keep it. */
  normalizeError?: (message: AssistantMessage) => Promise<string | undefined>;
  /** Host catalog model builder; defaults to OMP's `pi-catalog` `buildModel`. */
  loadModelBuilder?: () => Promise<OmpModelBuilder | undefined>;
}

function messageOf(event: AssistantMessageEvent): AssistantMessage {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return event.partial;
}

async function* relabelEvents(
  upstream: AssistantMessageEventStream,
  innerApi: GatewayApi,
  outerApi: Api,
  normalizeError: OmpGatewayProviderOptions["normalizeError"],
): AsyncGenerator<AssistantMessageEvent> {
  for await (const event of upstream) {
    // OMP must see its registered custom API so history replays back through this stream.
    const message = messageOf(event);
    if (message.api === innerApi) message.api = outerApi;
    if (event.type === "error") {
      const normalized = await normalizeError?.(event.error);
      if (normalized) event.error.errorMessage = normalized;
    }
    yield event;
  }
}

/** OMP catalog `buildModel`: resolves identity, thinking, and transport compat for a spec. */
export type OmpModelBuilder = (spec: Model<Api>) => Model<Api>;
let hostModelBuilder: Promise<OmpModelBuilder | undefined> | undefined;

/**
 * OMP resolves transport compat (`model.compat`) from catalog policy only for
 * built-in API names, so a relabeled model must be rebuilt the way OMP builds
 * any custom provider model on that API.
 */
function loadOmpModelBuilder(): Promise<OmpModelBuilder | undefined> {
  // OMP-only host package, absent from the Pi SDK, so it cannot be a static import.
  // OMP's legacy remap covers static imports only; dynamic ones need the canonical scope.
  const specifier = "@oh-my-pi/pi-catalog/build";
  hostModelBuilder ??= import(specifier).then(
    (module: unknown) =>
      module && typeof module === "object" && "buildModel" in module
        ? (module.buildModel as OmpModelBuilder)
        : undefined,
    () => undefined,
  );
  return hostModelBuilder;
}

function resolveInnerModel(
  model: Model<Api>,
  innerApi: GatewayApi,
  buildModel: OmpModelBuilder | undefined,
): Model<GatewayApi> {
  const relabeled = { ...model, api: innerApi } as Model<GatewayApi>;
  if (!buildModel) return relabeled;
  // Rebuild from the configured spec: drop policy-derived fields OMP recomputes.
  const configured: unknown = Reflect.get(model, "compatConfig");
  const spec: Record<string, unknown> = { ...relabeled };
  for (const key of ["identity", "compat", "compatConfig", "requiresGlyphTokenization"])
    delete spec[key];
  if (configured && typeof configured === "object") spec.compat = configured;
  // The spec is the relabeled registry model minus derived fields: a valid ModelSpec.
  const rebuilt = buildModel(spec as unknown as Model<Api>);
  return rebuilt as Model<GatewayApi>;
}

/** OMP stream for one custom API: relabel, route through the Pi-shared adapters, relabel back. */
export function createOmpGatewayStream(
  runtime: GatewayProviderRuntime,
  innerApi: GatewayApi,
  options: OmpGatewayProviderOptions = {},
): NonNullable<OmpGatewayProviderConfig["streamSimple"]> {
  return (model, context, streamOptions) => {
    const outerApi = model.api;
    const innerContext: Context = {
      ...context,
      messages: context.messages.map((message) =>
        message.role === "assistant" && message.api === outerApi
          ? { ...message, api: innerApi }
          : message,
      ),
    };
    const root = runtime.authController.resolveConfiguredRoot();
    return lazyStream(
      model,
      async () => {
        if (!root) throw new Error(UNCONFIGURED_ERROR);
        const loadBuilder = options.loadModelBuilder ?? loadOmpModelBuilder;
        const innerModel = resolveInnerModel(model, innerApi, await loadBuilder());
        // Pi declares transcript contexts; OMP's own transports consume its Context.
        const hostContext = innerContext as unknown as TranscriptContext;
        const upstream = runtime.apiStreams[innerApi].streamSimple(innerModel, hostContext, {
          ...streamOptions,
          env: { [GATEWAY_RESOLVED_ROOT_ENV]: root },
        });
        return relabelEvents(upstream, innerApi, outerApi, options.normalizeError);
      },
      undefined,
      streamOptions?.signal,
    );
  };
}

function hostThinking(model: Model<GatewayApi>): unknown {
  const references = getHostCatalogModels().filter((candidate) => candidate.id === model.id);
  const preferred = references.find((candidate) => candidate.api === model.api) ?? references[0];
  return preferred && "thinking" in preferred ? preferred.thinking : undefined;
}

/** Project one admitted Gateway model onto an OMP dynamic model row. */
export function toOmpGatewayModelConfig(model: Model<GatewayApi>): OmpGatewayModelConfig {
  const thinking = model.reasoning ? hostThinking(model) : undefined;
  return {
    id: model.id,
    name: model.name,
    api: OMP_GATEWAY_APIS[model.api],
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.compat ? { compat: model.compat } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

/** Provider configs in registration order: one custom API each, then auth and discovery. */
export function buildOmpGatewayProviderConfigs(
  runtime: GatewayProviderRuntime,
  options: OmpGatewayProviderOptions = {},
): OmpGatewayProviderConfig[] {
  const apis = Object.keys(OMP_GATEWAY_APIS) as GatewayApi[];
  return [
    ...apis.map((innerApi) => ({
      api: OMP_GATEWAY_APIS[innerApi],
      streamSimple: createOmpGatewayStream(runtime, innerApi, options),
    })),
    {
      // Fallback only: a key saved by `/login` wins. Omitted when unset so OMP
      // never treats the variable name itself as a credential.
      ...(process.env[API_KEY_ENV]?.trim() ? { apiKey: API_KEY_ENV } : {}),
      oauth: {
        name: "SF LLM Gateway API key",
        login: (callbacks) => runtime.authController.ompLogin(callbacks),
      },
      async fetchDynamicModels(apiKey) {
        const key = apiKey?.trim();
        if (!key) throw new Error("Gateway model refresh requires a resolved API key.");
        const root = runtime.authController.resolveConfiguredRoot();
        if (!root) throw new Error("Gateway model refresh requires a resolved gateway root URL.");
        const models = await runtime.discoverModels(
          key,
          root,
          AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        );
        return models.map(toOmpGatewayModelConfig);
      },
    },
  ];
}

/** Register the Gateway with OMP's provider registry. */
export function registerOmpGatewayProvider(
  host: OmpProviderHost,
  runtime: GatewayProviderRuntime,
  options: OmpGatewayProviderOptions = {},
): void {
  for (const config of buildOmpGatewayProviderConfigs(runtime, options)) {
    host.registerProvider(PROVIDER_NAME, config);
  }
}
