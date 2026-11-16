/* SPDX-License-Identifier: Apache-2.0 */
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-lsp";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export default async function check(api: SmokeApi): Promise<void> {
  const { requireTrue } = api;

  await api.run("lsp.tool_result.post-edit-feedback", ID, async () => {
    const [handler] = api.handlers(ID, "tool_result");
    requireTrue(handler, "sf-lsp registered no tool_result handler.");
    const result = record(
      await handler(
        {
          type: "tool_result",
          toolName: "write",
          toolCallId: "lsp-smoke",
          input: { path: "force-app/main/default/lwc/smokeInvalid/smokeInvalid.js", content: "" },
          content: [{ type: "text", text: "Successfully wrote smokeInvalid.js" }],
          details: {},
          isError: false,
        },
        api.ctx,
      ),
    );
    const parts = (result.content ?? []) as Array<{ text?: string }>;
    const text = parts.map((part) => part.text ?? "").join("\n");
    const metadata = record(record(result.details).sfPiDiagnostics);
    // Isolated state has no LWC language server: the edit result must carry the
    // actionable setup note (live diagnostics need a provisioned server).
    requireTrue(
      parts[0]?.text === "Successfully wrote smokeInvalid.js" &&
        (text.includes("LSP feedback: smokeInvalid.js") || text.includes("LWC LSP is unavailable")),
      `No post-edit LSP feedback appended: ${JSON.stringify(result)}`,
    );
    return { status: metadata.status, appended: parts.slice(1).map((part) => part.text) };
  });
  api.skip(
    "lsp.tool_result.live-diagnostics",
    ID,
    "blocked",
    "Needs a provisioned lwc-language-server/Apex jar in the isolated state; proven separately by an RPC mock-model run with SF_LSP_LWC_COMMAND (LWC1007 appended to the write result).",
  );

  for (const sub of ["", "doctor", "help", "verbose on", "verbose off"]) {
    await api.run(`lsp.command.${sub.replace(" ", "-") || "no-args"}`, ID, async () => {
      const output = await api.runCommand(ID, sub, { hasUI: sub.startsWith("verbose") });
      requireTrue(output.text.trim().length > 0, `/sf-lsp ${sub} produced no output.`);
      return { chars: output.text.length, head: output.text.slice(0, 160) };
    });
  }
}
