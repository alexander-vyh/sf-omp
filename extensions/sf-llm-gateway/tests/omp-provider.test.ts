/* SPDX-License-Identifier: Apache-2.0 */
/** Behavior proofs for the OMP provider registration (custom APIs, discovery, login). */
import { describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  OMP_GATEWAY_APIS,
  buildOmpGatewayProviderConfigs,
  createOmpGatewayStream,
  toOmpGatewayModelConfig,
} from "../lib/omp-provider.ts";
import {
  createGatewayProviderAuth,
  GATEWAY_RESOLVED_ROOT_ENV,
  type GatewayProviderAuthConfig,
} from "../lib/provider-auth.ts";
import {
  createGatewayProviderRuntime,
  type GatewayApi,
  type GatewayStreamImplementations,
} from "../lib/provider.ts";
import { GATEWAY_PRIORITY_ENV } from "../lib/transport-internal/openai-responses.ts";

const ROOT = "https://gateway.example.test";
/** Pi has no OMP catalog builder; route with the relabeled model as-is. */
const NO_BUILDER = { loadModelBuilder: async () => undefined };

function message(model: Model<Api>, stopReason: "stop" | "error" = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: stopReason === "stop" ? [{ type: "text", text: "ok" }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "upstream exploded" } : {}),
    timestamp: 0,
  };
}

interface Seen {
  api: string;
  baseUrl: string;
  root?: string;
  priority?: string;
  historyApis: string[];
}

function recordingStreams(seen: Seen[], fail = false): GatewayStreamImplementations {
  const simple = (model: Model<Api>, context: unknown, options?: StreamOptions) => {
    const messages = (context as Context).messages;
    seen.push({
      api: model.api,
      baseUrl: model.baseUrl,
      root: options?.env?.[GATEWAY_RESOLVED_ROOT_ENV],
      priority: options?.env?.[GATEWAY_PRIORITY_ENV],
      historyApis: messages.flatMap((entry) => (entry.role === "assistant" ? [entry.api] : [])),
    });
    const stream = createAssistantMessageEventStream();
    const result = message(model, fail ? "error" : "stop");
    queueMicrotask(() => {
      stream.push({ type: "start", partial: result });
      stream.push(
        fail
          ? { type: "error", reason: "error", error: result }
          : { type: "done", reason: "stop", message: result },
      );
      stream.end(result);
    });
    return stream;
  };
  const unused = () => {
    throw new Error("OMP dispatches only simple streams.");
  };
  return {
    anthropicFull: unused,
    chatFull: unused,
    responsesFull: unused,
    anthropicSimple: simple,
    chatSimple: simple,
    responsesSimple: simple,
  };
}

function runtime(
  options: { seen?: Seen[]; fail?: boolean; config?: GatewayProviderAuthConfig } = {},
) {
  const saved: string[] = [];
  const authController = createGatewayProviderAuth({
    promptBridge: { bind: vi.fn(), clear: vi.fn() } as never,
    getConfig: () => options.config ?? { enabled: true, baseUrl: ROOT, baseUrlSource: "saved" },
    saveGlobalBaseUrl: (baseUrl) => saved.push(baseUrl),
  });
  const gateway = createGatewayProviderRuntime({
    authController,
    streams: recordingStreams(options.seen ?? [], options.fail),
    isCatalogBackedModelId: () => true,
    fetchers: {
      modelIds: vi.fn(async () => ({
        ids: ["example-claude-model", "example-responses-model"],
        filteredIds: [],
        modelInfo: {},
      })),
      modelInfo: vi.fn(async () => ({
        "example-responses-model": { id: "example-responses-model", mode: "responses" as const },
      })),
    },
  });
  gateway.bind("/workspace", {} as ExtensionUIContext, "rpc");
  return { gateway, saved };
}

function ompModel(innerApi: GatewayApi, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: OMP_GATEWAY_APIS[innerApi] as Api,
    provider: "sf-llm-gateway",
    baseUrl: "https://gateway.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

describe("OMP Gateway provider registration", () => {
  it("registers one custom API per real Gateway API, then login and discovery", () => {
    const configs = buildOmpGatewayProviderConfigs(runtime().gateway);

    expect(configs.slice(0, 3).map((config) => config.api)).toEqual([
      "sf-llm-gateway-anthropic-messages",
      "sf-llm-gateway-openai-completions",
      "sf-llm-gateway-openai-responses",
    ]);
    expect(configs.slice(0, 3).every((config) => typeof config.streamSimple === "function")).toBe(
      true,
    );
    expect(configs[3]?.oauth?.name).toBe("SF LLM Gateway API key");
    expect(configs[3]).not.toHaveProperty("apiKey");
  });

  it("discovers admitted models as OMP rows tagged with their custom API", async () => {
    const { gateway } = runtime();
    const discovery = buildOmpGatewayProviderConfigs(gateway)[3]?.fetchDynamicModels;

    const rows = await discovery?.("fixture-key");

    expect(rows?.map((row) => [row.id, row.api])).toEqual([
      ["example-claude-model", "sf-llm-gateway-anthropic-messages"],
      ["example-responses-model", "sf-llm-gateway-openai-responses"],
    ]);
    expect(gateway.getLastDiscovery()).toMatchObject({ source: "gateway" });
  });

  it("refuses discovery without a key or configured root, without network", async () => {
    const missingRoot = runtime({ config: { enabled: true } }).gateway;
    const configured = runtime().gateway;

    await expect(
      buildOmpGatewayProviderConfigs(configured)[3]?.fetchDynamicModels?.(undefined),
    ).rejects.toThrow("requires a resolved API key");
    await expect(
      buildOmpGatewayProviderConfigs(missingRoot)[3]?.fetchDynamicModels?.("fixture-key"),
    ).rejects.toThrow("requires a resolved gateway root URL");
  });

  it("routes a custom-API request through the real-API adapter and relabels events", async () => {
    const seen: Seen[] = [];
    const { gateway } = runtime({ seen });
    const model = ompModel("openai-responses", "gpt-5.6-sol");
    const history = { ...message(model), api: model.api };
    const specs: Array<Record<string, unknown>> = [];
    const stream = createOmpGatewayStream(gateway, "openai-responses", {
      loadModelBuilder: async () => (spec) => {
        specs.push({ ...spec });
        return { ...spec, compat: { rebuilt: true } } as Model<Api>;
      },
    })({ ...model, compat: { stale: true }, compatConfig: { configured: true } } as Model<Api>, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }, history],
    });

    const result = await stream.result();

    expect(seen).toEqual([
      {
        api: "openai-responses",
        baseUrl: ROOT,
        root: ROOT,
        priority: "on",
        historyApis: ["openai-responses"],
      },
    ]);
    expect(result.api).toBe("sf-llm-gateway-openai-responses");
    expect(result.stopReason).toBe("stop");
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ api: "openai-responses", compat: { configured: true } });
    expect(specs[0]).not.toHaveProperty("compatConfig");
  });

  it("uses the Chat Completions endpoint for completions models", async () => {
    const seen: Seen[] = [];
    const { gateway } = runtime({ seen });
    const model = ompModel("openai-completions", "example-chat-model");

    await createOmpGatewayStream(
      gateway,
      "openai-completions",
      NO_BUILDER,
    )(model, {
      messages: [],
    }).result();

    expect(seen[0]).toMatchObject({ api: "openai-completions", baseUrl: `${ROOT}/v1` });
  });

  it("normalizes Gateway errors at the stream boundary", async () => {
    const { gateway } = runtime({ fail: true });
    const model = ompModel("anthropic-messages", "example-claude-model");
    const normalizeError = vi.fn(async () => "bounded guidance");

    const result = await createOmpGatewayStream(gateway, "anthropic-messages", {
      ...NO_BUILDER,
      normalizeError,
    })(model, { messages: [] }).result();

    expect(normalizeError).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "bounded guidance",
      api: "sf-llm-gateway-anthropic-messages",
    });
  });

  it("fails an unconfigured request with the recognized unconfigured error", async () => {
    const seen: Seen[] = [];
    const { gateway } = runtime({ seen, config: { enabled: true } });
    const model = ompModel("anthropic-messages", "example-claude-model");

    const result = await createOmpGatewayStream(
      gateway,
      "anthropic-messages",
      NO_BUILDER,
    )(model, {
      messages: [],
    }).result();

    expect(seen).toEqual([]);
    expect(result.errorMessage).toBe("Provider is not configured: sf-llm-gateway");
  });

  it("projects admitted models without changing their identity or limits", () => {
    const row = toOmpGatewayModelConfig({
      ...ompModel("anthropic-messages", "example-claude-model"),
      api: "anthropic-messages",
    } as Model<GatewayApi>);

    expect(row).toMatchObject({
      id: "example-claude-model",
      api: "sf-llm-gateway-anthropic-messages",
      contextWindow: 128_000,
      maxTokens: 4_096,
    });
  });
});

describe("OMP Gateway login", () => {
  it("saves only the non-secret root URL and returns the masked key", async () => {
    const { gateway, saved } = runtime({ config: { enabled: true } });
    const prompts: Array<{ message: string; secret?: boolean }> = [];
    const answers = ["https://new-gateway.example.test/v1", "  fixture-key  "];

    const key = await gateway.authController.ompLogin({
      async onPrompt(prompt) {
        prompts.push(prompt);
        return answers.shift() ?? "";
      },
    });

    expect(key).toBe("fixture-key");
    // The `/v1` suffix is normalized away; the saved value is the Gateway root.
    expect(saved).toEqual(["https://new-gateway.example.test"]);
    expect(prompts.map((prompt) => Boolean(prompt.secret))).toEqual([false, true]);
  });

  it("keeps the current root on Enter and rejects an empty key", async () => {
    const { gateway, saved } = runtime();

    await expect(gateway.authController.ompLogin({ onPrompt: async () => "" })).rejects.toThrow(
      "API key is required",
    );
    expect(saved).toEqual([]);
  });
});
