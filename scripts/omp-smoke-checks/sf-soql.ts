/* SPDX-License-Identifier: Apache-2.0 */
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-soql";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function text(result: unknown): string {
  const content = record(result).content;
  return (Array.isArray(content) ? content : [])
    .map((part) => String(record(part).text ?? ""))
    .join("\n");
}

export default async function check(api: SmokeApi): Promise<void> {
  const { requireTrue, details } = api;

  await api.run("soql.tool.history-empty", ID, async () => {
    const result = await api.requireSuccess("sf_soql", { action: "history.last" });
    requireTrue(
      text(result).includes("SOQL History · empty"),
      `Unexpected empty history: ${text(result)}`,
    );
    return details(result);
  });

  // Every org-connected action resolves the org first; with no authenticated org in
  // the isolated state it must fail closed with a structured error, never a network call.
  for (const [action, params] of [
    ["query.validate", { query: "SELECT Id, Name FROM Account LIMIT 2" }],
    ["schema.describe", { object: "Account" }],
    ["query.count", { query: "SELECT COUNT() FROM Account" }],
  ] as const) {
    await api.run(`soql.tool.${action}.no-org`, ID, async () => {
      const result = await api.invoke("sf_soql", { action, ...params });
      const value = details(result);
      requireTrue(
        value.ok === false || record(result).isError === true,
        `${action} without an org did not fail: ${JSON.stringify(result)}`,
      );
      requireTrue(text(result).includes("failed"), `No failure digest: ${text(result)}`);
      return { action, head: text(result).split("\n").slice(0, 6) };
    });
  }
  api.skip(
    "soql.tool.live-query",
    ID,
    "blocked",
    "Schema describe, validation against org schema, query plan and bounded runs need an authenticated Salesforce org.",
  );

  for (const sub of ["", "status", "help"]) {
    await api.run(`soql.command.${sub || "no-args"}`, ID, async () => {
      const output = await api.runCommand(ID, sub);
      requireTrue(output.text.trim().length > 0, `/sf-soql ${sub} produced no output.`);
      return { chars: output.text.length, head: output.text.slice(0, 160) };
    });
  }
}
