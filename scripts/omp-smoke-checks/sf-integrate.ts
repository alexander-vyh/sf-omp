/* SPDX-License-Identifier: Apache-2.0 */
import type { SalesforceSession } from "../../lib/common/sf-conn/index.ts";
import { testOutboundConnection } from "../../extensions/sf-integrate/lib/outbound-operations.ts";
import {
  renderIntegrationCall,
  renderIntegrationResult,
} from "../../extensions/sf-integrate/lib/render.ts";
import { SF_INTEGRATE_ACTIONS, type ToolResult } from "../../extensions/sf-integrate/lib/types.ts";
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-integrate";
const TOOL = "sf_integrate";
// Hermetic smoke HOME has no Salesforce auth, so any alias is unknown locally.
const MISSING_ORG = "sf-integrate-smoke-missing-org";

function text(result: unknown): string {
  const content: unknown = Reflect.get(Object(result), "content");
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const value: unknown = Reflect.get(Object(first), "text");
  return typeof value === "string" ? value : "";
}

export default async function check(api: SmokeApi): Promise<void> {
  // Explicit annotation lets TypeScript apply the assertion signature (TS2775).
  const requireTrue: SmokeApi["requireTrue"] = api.requireTrue;

  await api.run("integrate.tool.status", ID, async () => {
    const result = await api.requireSuccess(TOOL, { action: "status" });
    const details = api.details(result);
    requireTrue(details.action === "status", JSON.stringify(details));
    requireTrue(
      JSON.stringify(details.supported_presets) === JSON.stringify(["headless-360"]),
      JSON.stringify(details.supported_presets),
    );
    requireTrue(text(result).startsWith("SF Integrate is ready"), text(result));
    return { text: text(result), presets: details.supported_presets };
  });

  await api.run("integrate.tool.explicit-target-required", ID, async () => {
    const actions = SF_INTEGRATE_ACTIONS.filter((action) => action !== "status");
    for (const action of actions) {
      for (const target of [undefined, "   "]) {
        const result = await api.invoke(TOOL, {
          action,
          direction: "outbound",
          ...(target === undefined ? {} : { target_org: target }),
        });
        const details = api.details(result);
        const expected = `${action} requires an explicit target_org.`;
        requireTrue(Reflect.get(Object(result), "isError") === true, JSON.stringify(result));
        requireTrue(
          details.ok === false && details.error === expected,
          `${action}: ${JSON.stringify(details)}`,
        );
        requireTrue(text(result) === `SF Integrate ${action} failed: ${expected}`, text(result));
      }
    }
    return { actions };
  });

  await api.run("integrate.tool.unknown-org-fails-closed", ID, async () => {
    const outcomes: Record<string, string> = {};
    for (const params of [
      { action: "org.preflight" },
      { action: "connection.test", named_credential_name: "ExampleNC", test_path: "/" },
      { action: "setup.apply", direction: "outbound", plan_id: "x", allow_mutation: true },
    ]) {
      const result = await api.invoke(TOOL, { ...params, target_org: MISSING_ORG });
      const details = api.details(result);
      requireTrue(Reflect.get(Object(result), "isError") === true, JSON.stringify(result));
      requireTrue(
        details.ok === false &&
          typeof details.error === "string" &&
          details.error.includes(`No authorization information found for ${MISSING_ORG}`),
        `${params.action}: ${JSON.stringify(details)}`,
      );
      requireTrue(
        text(result) === `SF Integrate ${params.action} failed: ${details.error}`,
        text(result),
      );
      outcomes[params.action] = details.error;
    }
    return outcomes;
  });

  await api.run("integrate.tool.renderers", ID, async () => {
    const theme: unknown = Reflect.get(Object(Reflect.get(Object(api.ctx), "ui")), "theme");
    requireTrue(
      typeof Reflect.get(Object(theme), "fg") === "function",
      "ctx.ui.theme unavailable in smoke mode",
    );
    const typedTheme = theme as Parameters<typeof renderIntegrationCall>[1];
    const status = (await api.requireSuccess(TOOL, { action: "status" })) as ToolResult;
    const failed = (await api.invoke(TOOL, { action: "design.plan" })) as ToolResult;
    const call = renderIntegrationCall(
      { action: "connection.test", target_org: "ExampleOrg", named_credential_name: "ExampleNC" },
      typedTheme,
    ).render(100);
    const card = renderIntegrationResult(status, { expanded: true }, typedTheme).render(100);
    const error = renderIntegrationResult(failed, { expanded: false }, typedTheme).render(100);
    const partial = renderIntegrationResult(status, { isPartial: true }, typedTheme).render(100);
    const plain = (lines: string[]) => lines.join("\n").replace(/\u001b\[[0-9;]*m/gu, "");
    requireTrue(/SF Integrate/u.test(plain(call)) && /ExampleNC/u.test(plain(call)), plain(call));
    requireTrue(/SF Integrate · ready/u.test(plain(card)), plain(card));
    requireTrue(/requires an explicit target_org/u.test(plain(error)), plain(error));
    requireTrue(/running/u.test(plain(partial)), plain(partial));
    return { call: plain(call), cardLines: card.length, error: plain(error) };
  });

  await api.run("integrate.connection-test.omp-handoff", ID, async () => {
    // The registered tool connects to an org before connection.test, so the
    // OMP handoff branch runs here directly with a local session fixture.
    requireTrue(
      typeof Reflect.get(Object(api.ctx), "executeTool") !== "function",
      "OMP ctx unexpectedly exposes executeTool",
    );
    const session = {
      target: { targetOrg: "ExampleOrg", orgType: "developer", apiVersion: "67.0" },
    } as unknown as SalesforceSession;
    const result = await testOutboundConnection(
      {
        action: "connection.test",
        target_org: "ExampleOrg",
        named_credential_name: "ExampleNC",
        test_path: "/health",
      },
      session,
      undefined,
    );
    const handoff = Reflect.get(Object(result.details.handoff), "arguments") as unknown;
    requireTrue(result.details.ok === false && result.details.tested === false, "claimed a pass");
    requireTrue(result.isError !== true && text(result).startsWith("NOT RUN:"), text(result));
    requireTrue(
      Reflect.get(Object(handoff), "action") === "anon.run" &&
        Reflect.get(Object(handoff), "allow_mutation") === false &&
        Reflect.get(Object(handoff), "target_org") === "ExampleOrg",
      JSON.stringify(handoff),
    );
    const theme = Reflect.get(Object(Reflect.get(Object(api.ctx), "ui")), "theme") as Parameters<
      typeof renderIntegrationResult
    >[2];
    const lines = renderIntegrationResult(result, { expanded: true }, theme).render(100);
    requireTrue(lines.join("\n").includes("handoff"), lines.join("\n"));
    return { tool: Reflect.get(Object(result.details.handoff), "tool"), handoff };
  });

  await api.run("integrate.command.subcommands", ID, async () => {
    const command = api.command(ID);
    requireTrue(command?.extension === ID, "/sf-integrate not registered");
    const notes: Array<{ message: string; level?: string }> = [];
    const base = api.ctx as object;
    const baseUi = Reflect.get(base, "ui") as object;
    const ui = new Proxy(baseUi, {
      get: (target, key) =>
        key === "notify"
          ? (message: string, level?: string) => notes.push({ message, level })
          : Reflect.get(target, key),
    });
    const ctx = new Proxy(base, {
      get: (target, key) => (key === "hasUI" ? true : key === "ui" ? ui : Reflect.get(target, key)),
    });
    await command.handler("status", ctx);
    await command.handler("HELP", ctx);
    await command.handler("bogus", ctx);
    requireTrue(
      notes[0]?.level === "info" && notes[0].message.startsWith("SF Integrate is installed."),
      JSON.stringify(notes[0]),
    );
    requireTrue(
      notes[1]?.level === "info" && notes[1].message.includes("/sf-integrate status"),
      JSON.stringify(notes[1]),
    );
    requireTrue(
      notes[2]?.level === "warning" &&
        notes[2].message === "Unknown /sf-integrate subcommand: bogus",
      JSON.stringify(notes[2]),
    );
    return { notes };
  });

  await api.run("integrate.command.no-args-headless", ID, async () => {
    const command = api.command(ID);
    requireTrue(command, "/sf-integrate not registered");
    requireTrue(Reflect.get(Object(api.ctx), "hasUI") === false, "smoke ctx unexpectedly has UI");
    const printed: string[] = [];
    const original = console.info;
    console.info = (...values: unknown[]) => {
      printed.push(values.map(String).join(" "));
    };
    try {
      await command.handler("", api.ctx);
    } finally {
      console.info = original;
    }
    requireTrue(printed[0]?.startsWith("SF Integrate is installed."), JSON.stringify(printed));
    return { printed };
  });

  await api.run("integrate.command.completions", ID, async () => {
    const command = api.command(ID);
    const all = command?.getArgumentCompletions?.("") as Array<{ value: string }> | null;
    const status = command?.getArgumentCompletions?.("st") as Array<{ value: string }> | null;
    requireTrue(
      JSON.stringify(all?.map((item) => item.value.trim()).sort()) ===
        JSON.stringify(["help", "status"]),
      JSON.stringify(all),
    );
    requireTrue(
      status?.[0]?.value.trim() === "status" && status.length === 1,
      JSON.stringify(status),
    );
    requireTrue(command?.getArgumentCompletions?.("status h") === null, "nested completion");
    return { all: all?.map((item) => item.value) };
  });

  for (const action of [
    "org.preflight",
    "design.plan",
    "setup.apply",
    "secret.populate",
    "oauth.authorize",
    "setup.verify",
    "connection.test",
    "mcp.handoff",
  ]) {
    api.skip(
      `integrate.live.${action}`,
      ID,
      "blocked",
      `${action} requires an authenticated Salesforce org (connectSalesforce, Metadata/Tooling APIs); smoke is offline with no org auth.`,
    );
  }
  api.skip(
    "integrate.command.manager-panel",
    ID,
    "not-tested",
    "/sf-integrate with no args opens the SF Pi Manager detail page only in interactive TUI mode; smoke runs without UI.",
  );
}
