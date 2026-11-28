/* SPDX-License-Identifier: Apache-2.0 */
/** Deterministic in-process provider for native-OMP runtime proofs. */
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

const PROVIDER = "sf-omp-offline";

/** Answer every turn with "done" without contacting any endpoint. */
function answerDone(model: Model<Api>): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
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
    stopReason: "stop",
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
  });
  return stream;
}

export default function offlineProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    api: PROVIDER,
    // Required with models; never contacted because streamSimple answers in-process.
    baseUrl: "http://127.0.0.1:9",
    apiKey: PROVIDER,
    streamSimple: answerDone,
    models: [
      {
        id: "probe",
        name: "SF OMP Offline Probe",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
    ],
  });
}
