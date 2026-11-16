/* SPDX-License-Identifier: Apache-2.0 */
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-code-analyzer";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export default async function check(api: SmokeApi): Promise<void> {
  const { requireTrue } = api;
  const sessionManager = record(record(api.ctx).sessionManager);
  const entries = () =>
    (
      Reflect.apply(sessionManager.getEntries as () => unknown[], sessionManager, []) as unknown[]
    ).map(record);

  await api.run("code-analyzer.session_stop.deferred-scan-after-edit", ID, async () => {
    const [collect] = api.handlers(ID, "tool_result");
    const [stop] = api.handlers(ID, "session_stop");
    requireTrue(collect && stop, "sf-code-analyzer is missing tool_result/session_stop handlers.");
    const before = entries().length;
    await collect(
      {
        type: "tool_result",
        toolName: "write",
        toolCallId: "code-analyzer-smoke",
        input: { path: "force-app/main/default/classes/SmokeInvalid.cls", content: "" },
        content: [{ type: "text", text: "ok" }],
        details: {},
        isError: false,
      },
      api.ctx,
    );
    const stopEvent = {
      type: "session_stop",
      messages: [],
      turn_id: 1,
      session_id: "code-analyzer-smoke",
      stop_hook_active: false,
      signal: new AbortController().signal,
    };
    const result = await stop(stopEvent, api.ctx);
    // Hermetic state has no Code Analyzer plugin readiness: the edited target is
    // reported as skipped instead of silently dropped or scanned.
    const transcript = entries()
      .slice(before)
      .filter((entry) => entry.customType === ID)
      .map((entry) => record(entry.data));
    requireTrue(
      result === undefined,
      `Unexpected continuation without readiness: ${JSON.stringify(result)}`,
    );
    requireTrue(
      transcript.some(
        (data) =>
          record(data.details).status === "skipped" && record(data.details).targetCount === 1,
      ),
      `No deferred-scan transcript for the edited Apex file: ${JSON.stringify(transcript)}`,
    );
    requireTrue((await stop(stopEvent, api.ctx)) === undefined, "Idle stop hook scheduled work.");
    return transcript.map((data) => data.content);
  });
  api.skip(
    "code-analyzer.session_stop.live-scan-continuation",
    ID,
    "blocked",
    "Needs the sf code-analyzer plugin (and Java) in the isolated state; proven separately by an RPC mock-model run with a cloned plugin dir (pmd findings → session_stop continuation).",
  );

  for (const sub of ["", "status", "help", "recipes"]) {
    await api.run(`code-analyzer.command.${sub || "no-args"}`, ID, async () => {
      const output = await api.runCommand(ID, sub);
      requireTrue(output.text.trim().length > 0, `/sf-code-analyzer ${sub} produced no output.`);
      requireTrue(
        !output.notifications.some((entry) => entry.level === "error"),
        `/sf-code-analyzer ${sub} reported an error: ${output.text.slice(0, 800)}`,
      );
      return { chars: output.text.length, head: output.text.slice(0, 160) };
    });
  }
}
