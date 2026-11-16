/* SPDX-License-Identifier: Apache-2.0 */
import { readFile, writeFile } from "node:fs/promises";
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-agentscript";

// Compiles cleanly but carries a Moderate quality finding (unused action).
const QUALITY_FINDING_AGENT = `system:
    instructions: "Help"
    messages:
        welcome: "Hi"
        error: "Error"
config:
    agent_name: "Quality_Smoke"
    agent_type: "AgentforceEmployeeAgent"
start_agent main:
    description: "Main"
    actions:
        lookup:
            description: "Lookup"
            inputs:
                query: string
            outputs:
                result: string
            target: "flow://Lookup"
    reasoning:
        instructions: ->
            | Help the user.
`;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export default async function check(api: SmokeApi): Promise<void> {
  const { requireTrue } = api;
  let callId = 0;

  // OMP chains tool_result handler results; mirror that across this extension's handlers.
  async function toolResult(path: string): Promise<Record<string, unknown>> {
    let current: Record<string, unknown> = {
      content: [{ type: "text", text: `Successfully wrote ${path}` }],
      details: {},
      isError: false,
    };
    for (const handler of api.handlers(ID, "tool_result")) {
      const update = record(
        await handler(
          {
            type: "tool_result",
            toolName: "write",
            toolCallId: `agentscript-smoke-${++callId}`,
            input: { path, content: "" },
            ...current,
          },
          api.ctx,
        ),
      );
      current = { ...current, ...update };
    }
    return current;
  }
  async function sessionStop(): Promise<unknown> {
    const [handler] = api.handlers(ID, "session_stop");
    requireTrue(handler, "sf-agentscript registered no session_stop handler.");
    return await handler(
      {
        type: "session_stop",
        messages: [],
        turn_id: 1,
        session_id: "agentscript-smoke",
        stop_hook_active: false,
        signal: new AbortController().signal,
      },
      api.ctx,
    );
  }
  const text = (result: Record<string, unknown>) =>
    (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");

  await api.run("agentscript.tool_result.compile-on-save-errors", ID, async () => {
    const result = await toolResult(api.file("Invalid.agent"));
    const body = text(result);
    requireTrue(
      body.includes("LSP feedback: Invalid.agent") && body.includes("Syntax error"),
      `Compile-on-save feedback missing: ${body}`,
    );
    requireTrue(
      record(record(result.details).sfPiDiagnostics).status === "error",
      "Diagnostics metadata did not record status=error.",
    );
    return { feedback: body.split("\n").slice(1, 4) };
  });

  await api.run("agentscript.tool_result.compile-on-save-recovered", ID, async () => {
    const target = api.file("Invalid.agent");
    const original = await readFile(target, "utf8");
    await writeFile(target, await readFile(api.file("NativeLocal.agent"), "utf8"));
    try {
      const body = text(await toolResult(target));
      requireTrue(body.includes("LSP now clean: Invalid.agent"), `Recovery note missing: ${body}`);
      return { feedback: body.split("\n").at(-1) };
    } finally {
      await writeFile(target, original);
    }
  });

  await api.run("agentscript.session_stop.quality-repair-continuation", ID, async () => {
    const target = api.file("QualitySmoke.agent");
    await writeFile(target, QUALITY_FINDING_AGENT);
    await toolResult(target);
    const first = record(await sessionStop());
    requireTrue(first.continue === true, `No repair continuation: ${JSON.stringify(first)}`);
    const payload = record(JSON.parse(String(first.additionalContext)));
    requireTrue(
      payload.task === "repair_agent_script_quality" &&
        payload.attempt === 1 &&
        JSON.stringify(payload.findings).includes("unused-action"),
      `Unexpected repair payload: ${String(first.additionalContext)}`,
    );
    // Same findings after another edit: the bounded loop stops instead of repeating.
    await toolResult(target);
    const second = await sessionStop();
    requireTrue(second === undefined, `Repair loop did not stop: ${JSON.stringify(second)}`);
    // Nothing pending: the stop hook is a no-op.
    requireTrue((await sessionStop()) === undefined, "Idle stop hook scheduled work.");
    return {
      payload: {
        task: payload.task,
        attempt: payload.attempt,
        signature: payload.finding_signature,
      },
    };
  });

  // Headless RPC output is mode-gated (prints only in print mode); assert the UI notification path.
  for (const sub of ["help", "doctor"]) {
    await api.run(`agentscript.command.${sub}`, ID, async () => {
      const output = await api.runCommand(ID, sub, { hasUI: true });
      requireTrue(output.text.trim().length > 0, `/sf-agentscript ${sub} produced no output.`);
      return { chars: output.text.length, head: output.text.slice(0, 200) };
    });
  }

  // `check` reports through notifications only (silent headless), so run it with UI.
  await api.run("agentscript.command.check", ID, async () => {
    const clean = await api.runCommand(ID, `check ${api.file("NativeLocal.agent")}`, {
      hasUI: true,
    });
    requireTrue(clean.text.includes("is clean"), `Clean check output: ${clean.text}`);
    const invalid = await api.runCommand(ID, `check ${api.file("Invalid.agent")}`, { hasUI: true });
    requireTrue(
      invalid.notifications.some((entry) => entry.level === "warning") &&
        invalid.text.includes("Syntax error"),
      `Invalid check output: ${invalid.text}`,
    );
    return { clean: clean.text, invalid: invalid.text.split("\n").slice(0, 4) };
  });
}
