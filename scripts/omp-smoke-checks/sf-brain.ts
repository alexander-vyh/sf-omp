/* SPDX-License-Identifier: Apache-2.0 */
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-brain";
const STYLE_OPEN = "<sf_pi_gpt6_response_style>";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export default async function check(api: SmokeApi): Promise<void> {
  const { requireTrue } = api;
  const handlers = api.handlers(ID, "before_agent_start");
  const event = (systemPrompt: string[]) => ({
    type: "before_agent_start",
    reason: "prompt",
    prompt: "smoke",
    systemPrompt,
  });
  // Same host ctx, with only the selected model swapped.
  const withModel = (model: unknown) =>
    new Proxy(api.ctx as object, {
      get: (target, key) => (key === "model" ? model : Reflect.get(target, key)),
    });

  await api.run("brain.before_agent_start.system-prompt-array", ID, async () => {
    requireTrue(
      handlers.length === 4,
      `Expected 4 before_agent_start handlers, got ${handlers.length}.`,
    );
    const stale = `${STYLE_OPEN}\nold\n</sf_pi_gpt6_response_style>`;
    const gateway = record(
      await handlers[0](
        event(["base policy", stale, "other extension"]),
        withModel({ provider: "sf-llm-gateway", id: "gpt-6-sol" }),
      ),
    ).systemPrompt;
    requireTrue(
      Array.isArray(gateway),
      `systemPrompt result is not an array: ${JSON.stringify(gateway)}`,
    );
    const sections = gateway as string[];
    requireTrue(
      sections[0] === "base policy" &&
        sections[1] === "other extension" &&
        sections.filter((section) => section.startsWith(STYLE_OPEN)).length === 1 &&
        !sections.includes(stale),
      `Gateway GPT-6 style block not replaced exactly once: ${JSON.stringify(sections)}`,
    );
    const other = record(await handlers[0](event(sections), api.ctx)).systemPrompt as string[];
    requireTrue(
      JSON.stringify(other) === JSON.stringify(["base policy", "other extension"]),
      `Style block not removed for the host model: ${JSON.stringify(other)}`,
    );
    return { gateway: sections.length, hostModel: other };
  });

  const injections: Array<[string, string, string]> = [
    ["constitution", "sf-brain-constitution", "<sf_engineering_constitution>"],
    ["display-capabilities", "sf-brain-display-capabilities", "<sf_display_capabilities>"],
    ["routing", "sf-pi-routing-summary", "<sf_pi_routing>"],
  ];
  for (const [index, [label, customType, tag]] of injections.entries()) {
    await api.run(`brain.before_agent_start.${label}`, ID, async () => {
      const message = record(record(await handlers[index + 1](event([]), api.ctx)).message);
      requireTrue(
        message.customType === customType &&
          message.display === false &&
          String(message.content).includes(tag),
        `Unexpected ${label} injection: ${JSON.stringify(message).slice(0, 600)}`,
      );
      return { customType, chars: String(message.content).length };
    });
  }

  await api.run("brain.context.latest-projection", ID, async () => {
    const [handler] = api.handlers(ID, "context");
    requireTrue(handler, "sf-brain registered no context handler.");
    const custom = (content: string) => ({
      role: "custom",
      customType: "sf-brain-constitution",
      content,
      display: false,
    });
    const user = { role: "user", content: "hi" };
    const result = record(
      await handler({ type: "context", messages: [custom("old"), user, custom("new")] }, api.ctx),
    );
    const messages = result.messages as Array<Record<string, unknown>> | undefined;
    requireTrue(
      messages?.length === 2 && messages[1]?.content === "new",
      `Older constitution copy was not projected out: ${JSON.stringify(result)}`,
    );
    return { kept: messages.map((message) => message.content) };
  });
}
