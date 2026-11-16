/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pi-ai runtime helpers that the Gateway needs on both Pi and OMP.
 *
 * OMP serves `@earendil-works/pi-ai` (and `/compat`) through a legacy shim that
 * omits several Pi 1.x root exports; a named import of a missing value fails the
 * whole extension load. Namespace reads never fail, so Pi keeps its own helpers
 * and OMP gets a small local equivalent or its generic API dispatcher, which
 * routes by `model.api` to the same built-in Messages/Completions/Responses
 * transports.
 */
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import * as piAi from "@earendil-works/pi-ai";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  AuthContext,
  Model,
} from "@earendil-works/pi-ai";

type PiAi = typeof piAi;
type PiAiCompat = typeof piAiCompat;

const ai: Partial<PiAi> = piAi;
const compat: Partial<PiAiCompat> & {
  getBundledProviders?: () => readonly string[];
} = piAiCompat;

function processEnvAuthContext(): AuthContext {
  return {
    async env(name) {
      const value = process.env[name];
      return typeof value === "string" && value.trim().length > 0 ? value : undefined;
    },
    async fileExists(path) {
      try {
        await access(path.startsWith("~") ? `${homedir()}${path.slice(1)}` : path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Pi's ambient auth context, or the same process-env/file view on OMP. */
export const defaultProviderAuthContext: PiAi["defaultProviderAuthContext"] =
  ai.defaultProviderAuthContext ?? processEnvAuthContext;

/** Pi's complete-Provider factory; undefined on OMP, which registers providers by config. */
export const createProvider: PiAi["createProvider"] | undefined = ai.createProvider;

function setupErrorMessage(
  model: Model<Api>,
  error: unknown,
  timestamp: number,
  stopReason: "aborted" | "error",
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp,
  };
}

function hostLazyStream(
  model: Model<Api>,
  setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
  _observer?: unknown,
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const startedAt = Date.now();
  const outer = piAi.createAssistantMessageEventStream();
  void setup()
    .then(async (inner) => {
      let result: AssistantMessage | undefined;
      for await (const event of inner) {
        outer.push(event);
        if (event.type === "done") result = event.message;
        else if (event.type === "error") result = event.error;
      }
      outer.end(result);
    })
    .catch((error: unknown) => {
      const reason = signal?.aborted ? "aborted" : "error";
      const message = setupErrorMessage(model, error, startedAt, reason);
      outer.push({ type: "error", reason, error: message });
      outer.end(message);
    });
  return outer;
}

/** Return a stream synchronously while async setup runs behind it. */
export const lazyStream: PiAi["lazyStream"] = ai.lazyStream ?? hostLazyStream;

/** Time-ordered UUIDv7 from Pi, or Bun's native generator on OMP. */
export const uuidv7: PiAi["uuidv7"] =
  ai.uuidv7 ??
  (() => {
    const bun: unknown = Reflect.get(globalThis, "Bun");
    if (bun && typeof bun === "object" && "randomUUIDv7" in bun) {
      const generate = bun.randomUUIDv7;
      if (typeof generate === "function") return String(Reflect.apply(generate, bun, []));
    }
    return globalThis.crypto.randomUUID();
  });

// OMP's dispatchers accept its own Context/options shape; the casts only bridge
// the Pi declaration types the rest of the extension is written against.
const hostStream = compat.stream as unknown as PiAiCompat["streamAnthropic"];
const hostStreamSimple = compat.streamSimple as unknown as PiAiCompat["streamSimpleAnthropic"];

export const streamAnthropic: PiAiCompat["streamAnthropic"] = compat.streamAnthropic ?? hostStream;
export const streamSimpleAnthropic: PiAiCompat["streamSimpleAnthropic"] =
  compat.streamSimpleAnthropic ?? hostStreamSimple;
export const streamOpenAICompletions: PiAiCompat["streamOpenAICompletions"] =
  compat.streamOpenAICompletions ??
  (hostStream as unknown as PiAiCompat["streamOpenAICompletions"]);
export const streamSimpleOpenAICompletions: PiAiCompat["streamSimpleOpenAICompletions"] =
  compat.streamSimpleOpenAICompletions ??
  (hostStreamSimple as unknown as PiAiCompat["streamSimpleOpenAICompletions"]);
export const streamOpenAIResponses: PiAiCompat["streamOpenAIResponses"] =
  compat.streamOpenAIResponses ?? (hostStream as unknown as PiAiCompat["streamOpenAIResponses"]);
export const streamSimpleOpenAIResponses: PiAiCompat["streamSimpleOpenAIResponses"] =
  compat.streamSimpleOpenAIResponses ??
  (hostStreamSimple as unknown as PiAiCompat["streamSimpleOpenAIResponses"]);

/** Host simple-stream dispatcher keyed by `model.api` (custom APIs included on OMP). */
export const hostStreamSimpleDispatch = compat.streamSimple as PiAiCompat["streamSimple"];

/** Every model in the host's built-in public catalog (Pi providers or OMP bundled catalog). */
export function getHostCatalogModels(): Model<Api>[] {
  const providers = compat.getProviders?.() ?? compat.getBundledProviders?.() ?? [];
  const getModels = compat.getModels as ((provider: string) => readonly Model<Api>[]) | undefined;
  return providers.flatMap((provider) => [...(getModels?.(provider) ?? [])]);
}
