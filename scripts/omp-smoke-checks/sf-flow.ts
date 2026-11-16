/* SPDX-License-Identifier: Apache-2.0 */
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-flow";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export default async function check(api: SmokeApi): Promise<void> {
  const { requireTrue } = api;
  const [toolResult] = api.handlers(ID, "tool_result");
  const [assistantMessage] = api.handlers(ID, "assistant_message");
  const [sessionStop] = api.handlers(ID, "session_stop");

  await api.run("flow.tool_result.post-edit-repair-feedback", ID, async () => {
    requireTrue(toolResult, "sf-flow registered no tool_result handler.");
    const result = record(
      await toolResult(
        {
          type: "tool_result",
          toolName: "write",
          toolCallId: "flow-smoke-edit",
          input: { path: "force-app/main/default/flows/SmokeInvalid.flow-meta.xml", content: "" },
          content: [{ type: "text", text: "Successfully wrote SmokeInvalid.flow-meta.xml" }],
          details: {},
          isError: false,
        },
        api.ctx,
      ),
    );
    const parts = Array.isArray(result.content) ? result.content.map(record) : [];
    const appended = parts
      .slice(1)
      .map((part) => String(part.text ?? ""))
      .join("\n");
    requireTrue(
      appended.includes("SF Flow diagnostics") && appended.includes("high"),
      `No post-edit Flow repair feedback: ${JSON.stringify(result)}`,
    );
    return { appended: appended.trim().split("\n").slice(0, 4) };
  });

  await api.run("flow.assistant_message.topology-appended", ID, async () => {
    requireTrue(
      assistantMessage && sessionStop,
      "sf-flow is missing assistant_message/session_stop.",
    );
    const diagnosed = await api.requireSuccess("sf_flow", {
      action: "diagnose.file",
      workspace: api.workspace,
      file: "force-app/main/default/flows/SmokeValid.flow-meta.xml",
    });
    const mermaid = record(record(api.details(diagnosed).digest).topology).mermaid;
    requireTrue(
      typeof mermaid === "string" && mermaid.trim(),
      "diagnose.file returned no topology.",
    );
    await toolResult(
      {
        type: "tool_result",
        toolName: "sf_flow",
        toolCallId: "flow-smoke-topology",
        input: { action: "diagnose.file" },
        content: record(diagnosed).content,
        details: record(diagnosed).details,
        isError: false,
      },
      api.ctx,
    );
    const message = { role: "assistant", content: [{ type: "text", text: "Flow reviewed." }] };
    const rewritten = record(
      await assistantMessage({ type: "assistant_message", message }, api.ctx),
    );
    const text = (Array.isArray(rewritten.content) ? rewritten.content : [])
      .map((part) => String(record(part).text ?? ""))
      .join("\n");
    requireTrue(
      text.startsWith("Flow reviewed.") && text.includes(mermaid),
      `Final message did not gain the Flow topology: ${JSON.stringify(rewritten).slice(0, 600)}`,
    );
    // Consumed once; a later final message is left untouched.
    requireTrue(
      (await assistantMessage({ type: "assistant_message", message }, api.ctx)) === undefined,
      "Topology was appended twice.",
    );
    await sessionStop({ type: "session_stop" }, api.ctx);
    return { appendedChars: text.length - "Flow reviewed.".length };
  });

  for (const sub of ["", "status", "help"]) {
    await api.run(`flow.command.${sub || "no-args"}`, ID, async () => {
      const output = await api.runCommand(ID, sub);
      requireTrue(output.text.trim().length > 0, `/sf-flow ${sub} produced no output.`);
      return { chars: output.text.length, head: output.text.slice(0, 160) };
    });
  }
}
