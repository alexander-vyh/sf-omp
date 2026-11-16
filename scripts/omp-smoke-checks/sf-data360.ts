/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, readFileSync } from "node:fs";
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-data360";

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((part) => part.text ?? "").join("\n");
}

/** Genuine OMP command context with a recording UI so command output is observable. */
function recordingCtx(api: SmokeApi, notes: Array<{ message: string; level?: string }>) {
  const base = api.ctx as object;
  const baseUi = Reflect.get(base, "ui") as object;
  const ui = new Proxy(baseUi, {
    get: (target, key) =>
      key === "notify"
        ? (message: string, level?: string) => notes.push({ message, level })
        : Reflect.get(target, key),
  });
  return new Proxy(base, {
    get: (target, key) => (key === "hasUI" ? true : key === "ui" ? ui : Reflect.get(target, key)),
  });
}

export default async function check(api: SmokeApi): Promise<void> {
  const { invoke, requireSuccess, requireTrue, details } = api;

  await api.run("data360.discover.route", ID, async () => {
    const result = await requireSuccess("sf_data360", {
      action: "discover.route",
      params: { intent: "list data model objects" },
    });
    const recommended = details(result).recommendedAction as { action?: string } | undefined;
    requireTrue(recommended?.action === "harmonize.dmo.list", `route: ${text(result)}`);
    return { recommended: recommended.action };
  });

  await api.run("data360.discover.action.search.artifact", ID, async () => {
    const result = await requireSuccess("sf_data360", {
      action: "discover.action.search",
      params: { query: "activation target" },
    });
    const artifact = details(result).artifactPath;
    requireTrue(typeof artifact === "string" && existsSync(artifact), "search artifact missing");
    const written = JSON.parse(readFileSync(artifact, "utf8")) as unknown;
    requireTrue(written && typeof written === "object", "artifact is not JSON");
    requireTrue(/matching Data 360 action/.test(text(result)), `search: ${text(result)}`);
    return { summary: text(result).split("\n")[0], artifactWritten: true };
  });

  await api.run("data360.discover.action.describe", ID, async () => {
    const result = await requireSuccess("sf_data360", {
      action: "discover.action.describe",
      params: { action: "harmonize.dmo.list" },
    });
    requireTrue(text(result).includes("List all Data Model Objects"), text(result));
    return { summary: text(result) };
  });

  await api.run("data360.discover.action.list", ID, async () => {
    const result = await requireSuccess("sf_data360", { action: "discover.action.list" });
    requireTrue(/\d+ Data 360 action/.test(text(result)), text(result));
    return { summary: text(result).split("\n")[0] };
  });

  await api.run("data360.validation.unknown-action", ID, async () => {
    const result = await invoke("sf_data360", { action: "nope.nope" });
    requireTrue(details(result).ok === false, "unknown action must fail");
    requireTrue(text(result).includes("Unknown sf_data360 action 'nope.nope'"), text(result));
    return { summary: text(result).split("\n")[0] };
  });

  await api.run("data360.validation.missing-required", ID, async () => {
    const result = await invoke("sf_data360", {
      action: "prepare.dlo.create",
      params: { name: "Demo__dll" },
      dry_run: true,
    });
    requireTrue(details(result).ok === false, "missing body must fail before any request");
    requireTrue(text(result).includes("requires: body"), text(result));
    return { summary: text(result).split("\n")[0] };
  });

  // Orchestration traces need >=2 non-local API calls, which only a live org
  // produces; feed recorded-shape tool_result digests into the real OMP hooks.
  await api.run("data360.trace.assistant_message", ID, async () => {
    const [toolResult] = api.handlers(ID, "tool_result");
    const [rewrite] = api.handlers(ID, "assistant_message");
    requireTrue(toolResult && rewrite, "tool_result/assistant_message handlers missing");
    for (const offset of [0, 200]) {
      await toolResult(
        {
          type: "tool_result",
          toolName: "sf_data360",
          isError: false,
          details: {
            digest: {
              action: "harmonize.dmo.list",
              namespace: "harmonize",
              status: "pass",
              api_calls: [
                {
                  transport: "CONNECT",
                  method: "GET",
                  url: `https://example.my.salesforce.com/data-model-objects?offset=${offset}`,
                  status: 200,
                  outcome: "success",
                },
              ],
              sections: [{ title: "Outcome", rows: [{ label: "Resources", value: "200" }] }],
            },
          },
        },
        api.ctx,
      );
    }
    const rewritten = (await rewrite(
      {
        type: "assistant_message",
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      },
      api.ctx,
    )) as { content?: Array<{ text?: string }> } | undefined;
    const body = (rewritten?.content ?? []).map((part) => part.text ?? "").join("\n");
    requireTrue(body.includes("Data 360 Orchestration"), `no trace appended: ${body}`);
    return { traceAppended: true };
  });

  await api.run("data360.command.help-status-unknown", ID, async () => {
    const command = api.command("sf-data360");
    requireTrue(command?.extension === ID, "/sf-data360 not registered");
    const notes: Array<{ message: string; level?: string }> = [];
    const ctx = recordingCtx(api, notes);
    await command.handler("help", ctx);
    await command.handler("status", ctx);
    await command.handler("bogus", ctx);
    requireTrue(notes[0]?.message.includes("one agent-first SDK tool"), JSON.stringify(notes[0]));
    requireTrue(notes[1]?.message.includes("SF Data 360 — status"), JSON.stringify(notes[1]));
    requireTrue(
      notes[2]?.level === "warning" && notes[2].message.includes("Unknown /sf-data360"),
      JSON.stringify(notes[2]),
    );
    const completions = command.getArgumentCompletions?.("he") as Array<{ value: string }>;
    requireTrue(completions?.[0]?.value === "help", "completion");
    return { notes: notes.map((note) => note.message.split("\n")[0]) };
  });

  api.skip(
    "data360.org.actions",
    ID,
    "not-tested",
    "Dry-run/read/mutation actions resolve a live Data 360 org connection; offline smoke stops at validation.",
  );
}
