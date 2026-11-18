/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sf-feedback offline behavior in native OMP. The real /sf-feedback command runs
 * headless (RPC host: no UI), so it may only draft: it collects sanitized local
 * diagnostics and emits a prefilled sf-omp issue URL, never creating an issue.
 */
import type { SmokeApi } from "../omp-smoke-extension.ts";
import { OMP_VERSION } from "../omp-runtime.ts";

const EXTENSION = "sf-feedback";
const ISSUE_NEW_PATH = "/alexander-vyh/sf-omp/issues/new";

/** The slice of OMP's ExtensionContext these checks read. */
interface FeedbackSmokeContext {
  hasUI: boolean;
  sessionManager: {
    getBranch(): Array<{ type: string; customType?: string; data?: unknown }>;
  };
}

interface HumanOnlyOutput {
  title: string;
  body: string;
  severity: string;
}

/** Run one real command invocation and return the human-only entry it appended. */
async function runCommand(api: SmokeApi, args: string): Promise<HumanOnlyOutput> {
  const command = api.command("sf-feedback");
  api.requireTrue(command?.extension === EXTENSION, "sf-feedback did not register /sf-feedback.");
  const ctx = api.ctx as FeedbackSmokeContext;
  api.requireTrue(ctx.hasUI === false, "Smoke expects the headless RPC host context.");
  const before = ctx.sessionManager.getBranch().length;
  await command.handler(args, api.ctx);
  const appended = ctx.sessionManager
    .getBranch()
    .slice(before)
    .filter((entry) => entry.type === "custom" && entry.customType === EXTENSION);
  api.requireTrue(
    appended.length === 1,
    `Expected exactly one sf-feedback output entry for "${args}", got ${appended.length}.`,
  );
  const data = appended[0]?.data as Partial<HumanOnlyOutput> | undefined;
  api.requireTrue(
    typeof data?.title === "string" && typeof data.body === "string",
    `Malformed sf-feedback output entry: ${JSON.stringify(data)}`,
  );
  return data as HumanOnlyOutput;
}

export default async function feedbackChecks(api: SmokeApi): Promise<void> {
  await api.run("feedback.command.completions", EXTENSION, async () => {
    const completions = api.command("sf-feedback")?.getArgumentCompletions?.("diag");
    const first: unknown = Array.isArray(completions) ? completions[0] : undefined;
    api.requireTrue(
      Array.isArray(completions) &&
        completions.length === 1 &&
        first !== null &&
        typeof first === "object" &&
        "value" in first &&
        first.value === "diagnostics",
      `Unexpected /sf-feedback completions: ${JSON.stringify(completions)}`,
    );
    return completions;
  });

  await api.run("feedback.command.help", EXTENSION, async () => {
    const output = await runCommand(api, "help");
    api.requireTrue(
      output.title === "SF Feedback help" && output.body.includes("/sf-feedback diagnostics"),
      `Unexpected help output: ${JSON.stringify(output)}`,
    );
    return output;
  });

  await api.run("feedback.command.diagnostics", EXTENSION, async () => {
    const output = await runCommand(api, "diagnostics");
    api.requireTrue(
      output.title === "SF Feedback diagnostics" &&
        output.body.includes("## Diagnostics") &&
        output.body.includes(`Runtime: OMP ${OMP_VERSION}`),
      `Diagnostics did not identify the OMP host: ${output.body}`,
    );
    return { title: output.title, runtimeLine: `Runtime: OMP ${OMP_VERSION}` };
  });

  await api.run("feedback.command.headless-draft", EXTENSION, async () => {
    const output = await runCommand(api, "bug OMP smoke draft");
    api.requireTrue(
      output.title === "SF Feedback issue draft",
      `Headless /sf-feedback must only draft: ${JSON.stringify(output)}`,
    );
    const urlText = output.body.split("\n").find((line) => line.startsWith("https://github.com/"));
    api.requireTrue(urlText, `Draft has no fallback issue URL: ${output.body}`);
    const url = new URL(urlText);
    const body = url.searchParams.get("body") ?? "";
    api.requireTrue(
      url.pathname === ISSUE_NEW_PATH &&
        url.searchParams.get("title") === "[Bug] OMP smoke draft" &&
        url.searchParams.get("labels") === "feedback,bug" &&
        body.includes(`Runtime: OMP ${OMP_VERSION}`) &&
        body.includes("## Steps to reproduce"),
      `Fallback URL does not target the sf-omp issue form with the drafted body: ${url.origin}${url.pathname}`,
    );
    const home = process.env.HOME;
    api.requireTrue(
      !home || !output.body.includes(home),
      "Draft leaked the local home directory path.",
    );
    return {
      title: output.title,
      fallbackUrl: `${url.origin}${url.pathname}`,
      issueTitle: url.searchParams.get("title"),
      labels: url.searchParams.get("labels"),
    };
  });

  api.skip(
    "feedback.issue.create",
    EXTENSION,
    "not-tested",
    "Interactive confirm + gh issue create/browser fallback needs a TUI user and GitHub; headless smoke only drafts.",
  );
}
