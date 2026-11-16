/* SPDX-License-Identifier: Apache-2.0 */
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-guardrail";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export default async function check(api: SmokeApi): Promise<void> {
  const { requireTrue } = api;
  let callId = 0;

  // The registered tool_call handler with the genuine OMP ctx (headless: hasUI=false).
  async function toolCall(toolName: string, input: Record<string, unknown>): Promise<unknown> {
    const [handler] = api.handlers(ID, "tool_call");
    requireTrue(handler, "sf-guardrail registered no tool_call handler.");
    return await handler(
      { type: "tool_call", toolName, toolCallId: `guardrail-smoke-${++callId}`, input },
      api.ctx,
    );
  }

  await api.run("guardrail.tool_call.benign-allowed", ID, async () => {
    const result = await toolCall("bash", { command: "ls force-app" });
    requireTrue(result === undefined, `Benign command was intercepted: ${JSON.stringify(result)}`);
    return { result: "pass-through" };
  });

  await api.run("guardrail.tool_call.dangerous-command-headless-block", ID, async () => {
    const result = record(await toolCall("bash", { command: "rm -rf ./force-app" }));
    requireTrue(result.block === true, `rm -rf was not blocked: ${JSON.stringify(result)}`);
    requireTrue(
      String(result.reason).includes("recursive force delete") &&
        String(result.reason).includes("headless mode"),
      `Unexpected block reason: ${String(result.reason)}`,
    );
    return result;
  });

  await api.run("guardrail.tool_call.protected-file-block", ID, async () => {
    const result = record(
      await toolCall("write", { path: "manifest/destructiveChanges.xml", content: "<Package/>" }),
    );
    requireTrue(
      result.block === true,
      `Protected file write was not blocked: ${JSON.stringify(result)}`,
    );
    requireTrue(
      String(result.reason).includes("sf-destructive-changes-xml"),
      `Block reason does not name the file policy: ${String(result.reason)}`,
    );
    return result;
  });

  await api.run("guardrail.audit.records-decisions", ID, async () => {
    const output = await api.runCommand(ID, "audit");
    requireTrue(
      output.text.includes("rm -rf ./force-app") &&
        output.text.includes("manifest/destructiveChanges.xml"),
      `Audit does not list the smoke decisions: ${output.text.slice(0, 2000)}`,
    );
    return { entries: output.entries.map((entry) => entry.customType) };
  });

  await api.run("guardrail.before_agent_start.guidance", ID, async () => {
    const [handler] = api.handlers(ID, "before_agent_start");
    requireTrue(handler, "sf-guardrail registered no before_agent_start handler.");
    const message = record(
      record(
        await handler(
          { type: "before_agent_start", reason: "prompt", prompt: "smoke", systemPrompt: [] },
          api.ctx,
        ),
      ).message,
    );
    requireTrue(
      message.customType === "sf-guardrail-prompt" &&
        String(message.content).includes("<sf_guardrail>") &&
        message.display === false,
      `Unexpected guardrail injection: ${JSON.stringify(message)}`,
    );
    return { customType: message.customType, chars: String(message.content).length };
  });

  // `aliases` asks for input and `settings`/`forget` edit state; they are driven over RPC instead.
  for (const sub of ["", "status", "list", "grants", "help"]) {
    await api.run(`guardrail.command.${sub || "no-args"}`, ID, async () => {
      const output = await api.runCommand(ID, sub);
      requireTrue(output.text.trim().length > 0, `/sf-guardrail ${sub} produced no output.`);
      requireTrue(
        !output.notifications.some((entry) => entry.level === "error"),
        `/sf-guardrail ${sub} reported an error: ${output.text.slice(0, 1000)}`,
      );
      return { chars: output.text.length, head: output.text.slice(0, 160) };
    });
  }
}
