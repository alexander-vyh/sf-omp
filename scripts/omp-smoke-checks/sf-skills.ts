/* SPDX-License-Identifier: Apache-2.0 */
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-skills";

export default async function check(api: SmokeApi): Promise<void> {
  const { requireTrue } = api;

  for (const [sub, expected] of [
    ["", "SF Skills HUD summary"],
    ["summary", "SF Skills HUD summary"],
    ["help", "SF Skills HUD help"],
    ["metrics", "SF Skills usage metrics"],
    ["prune", ""],
    ["defaults status", ""],
  ] as const) {
    await api.run(`skills.command.${sub.replace(" ", "-") || "no-args"}`, ID, async () => {
      const output = await api.runCommand(ID, sub);
      requireTrue(output.text.trim().length > 0, `/sf-skills ${sub} produced no output.`);
      requireTrue(
        output.text.includes(expected),
        `/sf-skills ${sub} did not render "${expected}": ${output.text.slice(0, 600)}`,
      );
      requireTrue(
        !output.notifications.some((entry) => entry.level === "error"),
        `/sf-skills ${sub} reported an error: ${output.text.slice(0, 600)}`,
      );
      return { chars: output.text.length, head: output.text.slice(0, 200) };
    });
  }

  await api.run("skills.message_end.omp-skill-invocation-counter", ID, async () => {
    const [messageEnd] = api.handlers(ID, "message_end");
    requireTrue(messageEnd, "sf-skills registered no message_end handler.");
    // OMP's shape for a user `/skill:<name>` (rpc/interactive skill-prompt custom message).
    await messageEnd(
      {
        type: "message_end",
        message: {
          role: "custom",
          customType: "skill-prompt",
          content:
            '[IMPORTANT: User invoked the "sf-omp-startup-smoke" skill; follow its instructions.]',
          display: true,
          attribution: "user",
          details: { name: "sf-omp-startup-smoke", lineCount: 1 },
        },
      },
      api.ctx,
    );
    const output = await api.runCommand(ID, "metrics");
    requireTrue(
      output.text.includes("sf-omp-startup-smoke"),
      `Skill invocation was not counted: ${output.text}`,
    );
    return { metrics: output.text.split("\n").slice(0, 8) };
  });
  api.skip(
    "skills.command.interactive-panels",
    ID,
    "not-tested",
    "/sf-skills funnel and toggle open TUI overlays; smoke has no UI (driven separately over RPC).",
  );
}
