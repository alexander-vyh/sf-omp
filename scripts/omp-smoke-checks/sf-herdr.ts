/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sf-herdr offline behavior in native OMP. The planner only registers inside a
 * current split Herdr runtime, so the ready scenario reproduces exactly the
 * prerequisites in extensions/sf-herdr/tests/runtime-surface-scenarios.ts:
 * HERDR_ENV/HERDR_PANE_ID plus active herdr_layout/herdr_pane/herdr_agent tools.
 * Those three are inert OMP tool registrations (Herdr itself is not installed);
 * sf-herdr's real session_start hook then registers sf_herdr_plan natively.
 */
import type { SmokeApi } from "../omp-smoke-extension.ts";

const EXTENSION = "sf-herdr";
const HERDR_TOOLS = ["herdr_layout", "herdr_pane", "herdr_agent"] as const;
const PANE_ID = "omp-smoke-opaque-pane";

/** The slice of OMP's ExtensionContext used to read human-only command output. */
interface EntryContext {
  sessionManager: { getBranch(): Array<{ type: string; customType?: string; data?: unknown }> };
}

/** Bodies of human-only output entries a real command appended (never stdout in RPC). */
async function commandEntries(
  ctx: EntryContext,
  customType: string,
  action: () => Promise<unknown>,
): Promise<string[]> {
  const before = ctx.sessionManager.getBranch().length;
  await action();
  return ctx.sessionManager
    .getBranch()
    .slice(before)
    .filter((entry) => entry.type === "custom" && entry.customType === customType)
    .map((entry) => {
      const data = entry.data;
      return data && typeof data === "object" && "body" in data ? String(data.body) : "";
    });
}

function text(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item: unknown) =>
      item && typeof item === "object" && "text" in item && typeof item.text === "string"
        ? item.text
        : "",
    )
    .join("\n");
}

export default async function herdrChecks(api: SmokeApi): Promise<void> {
  const command = api.command("sf-herdr");

  async function runCommand(args: string): Promise<string> {
    api.requireTrue(command?.extension === EXTENSION, "sf-herdr did not register /sf-herdr.");
    const output = await commandEntries(api.ctx as EntryContext, EXTENSION, () =>
      command.handler(args, api.ctx),
    );
    api.requireTrue(
      output.length === 1,
      `Expected one /sf-herdr ${args} output, got ${output.length}.`,
    );
    return output[0] ?? "";
  }

  await api.run("herdr.command.status.not-ready", EXTENSION, async () => {
    const output = await runCommand("status");
    api.requireTrue(
      output.includes("Runtime: not inside Herdr pane") &&
        output.includes("missing herdr_layout, herdr_pane, herdr_agent") &&
        output.includes("Planner: not registered for this runtime"),
      `Unexpected not-ready status: ${output}`,
    );
    return output;
  });

  await api.run("herdr.command.doctor-help", EXTENSION, async () => {
    const doctor = await runCommand("doctor");
    const help = await runCommand("help");
    api.requireTrue(
      doctor.includes("○ sf_herdr_plan not eligible in this runtime") &&
        help.startsWith("Usage: /sf-herdr [status|doctor|settings|help]") &&
        help.includes("Current split direction: auto."),
      `Unexpected doctor/help output: ${doctor}\n${help}`,
    );
    return { doctor, help };
  });

  await api.run("herdr.plan.not-ready.unregistered", EXTENSION, async () => {
    const registered = api.pi.getAllTools().some((tool) => tool.name === "sf_herdr_plan");
    api.requireTrue(!registered, "sf_herdr_plan registered outside a split Herdr runtime.");
    return { registered };
  });

  const previousEnv = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  };
  const previousActive = api.pi.getActiveTools();
  try {
    await api.run("herdr.plan.ready.registers", EXTENSION, async () => {
      for (const name of HERDR_TOOLS) {
        api.pi.registerTool({
          name,
          label: name,
          description: "Inert OMP smoke prerequisite standing in for the absent Herdr tool.",
          parameters: api.pi.typebox.Type.Object({}),
          async execute() {
            throw new Error(`${name} is an OMP smoke readiness prerequisite only.`);
          },
        });
      }
      await api.pi.setActiveTools([...previousActive, ...HERDR_TOOLS]);
      process.env.HERDR_ENV = "1";
      process.env.HERDR_PANE_ID = PANE_ID;
      const sessionStarts = api.handlers(EXTENSION, "session_start");
      api.requireTrue(sessionStarts.length > 0, "sf-herdr has no session_start hook.");
      for (const sessionStart of sessionStarts)
        await sessionStart({ type: "session_start" }, api.ctx);
      const registered = api.pi.getAllTools().some((tool) => tool.name === "sf_herdr_plan");
      api.requireTrue(registered, "OMP did not register sf_herdr_plan in the ready runtime.");
      const status = await runCommand("status");
      api.requireTrue(
        status.includes("Planner: ready") && status.includes(`Current pane: ${PANE_ID}`),
        `Ready status mismatch: ${status}`,
      );
      return { registered, status };
    });

    await api.run("herdr.plan.command-intent", EXTENSION, async () => {
      const result = await api.requireSuccess("sf_herdr_plan", {
        intent: "run-tests",
        primaryWorkflow: "apex",
      });
      const plan = api.details(result).plan as {
        lifecycle?: string;
        steps?: Array<{ id: string; tool: string; action: string }>;
      };
      const steps = (plan.steps ?? []).map((step) => `${step.tool}.${step.action}`);
      api.requireTrue(
        plan.lifecycle === "ephemeral" &&
          steps.join(",") ===
            "herdr_layout.pane_split,herdr_pane.run,herdr_pane.wait_output,herdr_pane.close" &&
          text(result).includes(
            "herdr_pane.run · pane←split.details.pane.pane_id · caller supplies command",
          ),
        `Unexpected run-tests plan: ${JSON.stringify(result)}`,
      );
      return { lifecycle: plan.lifecycle, steps };
    });

    await api.run("herdr.plan.review-intent", EXTENSION, async () => {
      const result = await api.requireSuccess("sf_herdr_plan", {
        intent: "review",
        primaryWorkflow: "agentscript",
      });
      const plan = api.details(result).plan as {
        lifecycle?: string;
        steps?: Array<{ tool: string; action: string }>;
      };
      const steps = (plan.steps ?? []).map((step) => `${step.tool}.${step.action}`);
      api.requireTrue(
        plan.lifecycle === "manual" &&
          steps.join(",") ===
            "herdr_layout.pane_split,herdr_agent.start,herdr_agent.prompt,herdr_agent.read" &&
          text(result).includes("manual lifecycle; leave open until explicit cleanup"),
        `Unexpected review plan: ${JSON.stringify(result)}`,
      );
      return { lifecycle: plan.lifecycle, steps };
    });
  } finally {
    await api.pi.setActiveTools(previousActive);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  await api.run("herdr.tool-result.empty-run-normalized", EXTENSION, async () => {
    const [toolResult] = api.handlers(EXTENSION, "tool_result");
    api.requireTrue(toolResult, "sf-herdr has no tool_result hook.");
    const normalized = await toolResult(
      {
        type: "tool_result",
        toolName: "herdr_pane",
        toolCallId: "omp-smoke-herdr-run",
        input: { action: "run", pane: PANE_ID, command: "npm test" },
        content: [{ type: "text", text: "Expected JSON output from herdr pane run npm test" }],
        isError: true,
        details: undefined,
      },
      api.ctx,
    );
    api.requireTrue(
      JSON.stringify(normalized) ===
        JSON.stringify({
          content: [{ type: "text", text: `Submitted command to Herdr pane ${PANE_ID}.` }],
          isError: false,
        }),
      `Empty-body pane run was not normalized: ${JSON.stringify(normalized)}`,
    );
    return normalized;
  });

  api.skip(
    "herdr.live.panes",
    EXTENSION,
    "blocked",
    "Herdr is not installed; executing herdr_layout/herdr_pane/herdr_agent needs a live Herdr session.",
  );
}
