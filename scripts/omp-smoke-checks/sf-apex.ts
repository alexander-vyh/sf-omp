/* SPDX-License-Identifier: Apache-2.0 */
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-apex";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export default async function check(api: SmokeApi): Promise<void> {
  const { requireTrue } = api;

  await api.run("apex.tool_result.post-edit-diagnostics", ID, async () => {
    const [handler] = api.handlers(ID, "tool_result");
    requireTrue(handler, "sf-apex registered no tool_result handler.");
    const result = record(
      await handler(
        {
          type: "tool_result",
          toolName: "write",
          toolCallId: "apex-smoke",
          input: { path: "force-app/main/default/classes/SmokeInvalid.cls", content: "" },
          content: [{ type: "text", text: "Successfully wrote SmokeInvalid.cls" }],
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
    // The isolated state has no Apex language server, so the appended feedback is
    // the actionable unavailable note; with a server it carries compiler errors.
    requireTrue(
      parts[0]?.text === "Successfully wrote SmokeInvalid.cls" &&
        appended.includes("SF Apex diagnostics"),
      `No post-edit Apex feedback appended: ${JSON.stringify(result)}`,
    );
    return { appended: appended.trim().split("\n").slice(0, 3) };
  });

  for (const sub of ["", "status", "help"]) {
    await api.run(`apex.command.${sub || "no-args"}`, ID, async () => {
      const output = await api.runCommand(ID, sub);
      requireTrue(output.text.trim().length > 0, `/sf-apex ${sub} produced no output.`);
      return { chars: output.text.length, head: output.text.slice(0, 160) };
    });
  }
}
