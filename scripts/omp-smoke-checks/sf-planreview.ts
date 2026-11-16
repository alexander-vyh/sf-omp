/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sf-planreview offline behavior in native OMP: real /sf-planreview command
 * paths that need no Plannotator binary, and the real `input` hook that turns
 * Plannotator/Herdr annotation text into attributed feedback. OMP's input
 * runner applies a handler's `text`, so the hook's result is what OMP sends.
 * Installing and running the Plannotator TUI downloads a public binary and
 * takes over the terminal; that path is verified interactively, not here.
 */
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-planreview";
const REVIEW_FILE = "plan-review-00000000-0000-4000-8000-000000000001.md";

async function captureInfo(action: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  };
  try {
    await action();
  } finally {
    console.info = original;
  }
  return lines;
}

export default async function planReviewChecks(api: SmokeApi): Promise<void> {
  const { requireTrue } = api;
  const base = api.ctx as object;
  const baseUi = Reflect.get(base, "ui") as object;
  const notes: string[] = [];
  const ui = new Proxy(baseUi, {
    get: (target, key) =>
      key === "notify" ? (message: string) => notes.push(message) : Reflect.get(target, key),
  });
  // emit() only notifies when hasUI is true; dialogs are never reached on these paths.
  const ctx = new Proxy(base, {
    get: (target, key) => (key === "hasUI" ? true : key === "ui" ? ui : Reflect.get(target, key)),
  });
  const command = api.command(ID);

  await api.run("planreview.command.offline-paths", ID, async () => {
    requireTrue(command?.extension === ID, "/sf-planreview is not registered by sf-planreview.");
    const expected: Array<[string, string]> = [
      [
        "help",
        "Usage: /sf-planreview [last|history|file <path>|status|doctor|setup [tui|herdr]|cleanup|help]",
      ],
      ["bogus", "I don't recognize that review action."],
      ["last", "Nothing to review yet."],
      ["file", "Choose a text file to review: /sf-planreview file <path>."],
      ["cleanup", "No private review snapshots to clear."],
      ["status", "SF Plan Review: not installed · /sf-planreview setup"],
    ];
    const observed: Record<string, string | undefined> = {};
    for (const [args, prefix] of expected) {
      notes.length = 0;
      await command.handler(args, ctx);
      observed[args] = notes[0];
      requireTrue(
        notes.length === 1 && notes[0]?.startsWith(prefix),
        `/sf-planreview ${args}: ${JSON.stringify(notes)}`,
      );
    }
    return observed;
  });

  await api.run("planreview.command.doctor-headless", ID, async () => {
    requireTrue(command, "/sf-planreview is not registered.");
    const headless = new Proxy(base, {
      get: (target, key) => (key === "hasUI" ? false : Reflect.get(target, key)),
    });
    const output = await captureInfo(() => command.handler("doctor", headless));
    requireTrue(
      output.length === 1 &&
        output[0]?.startsWith("SF Plan Review") &&
        output[0].includes("No document-review TUI available") &&
        output[0].includes("Standalone TUI not installed"),
      `Unexpected doctor output: ${JSON.stringify(output)}`,
    );
    return output[0]?.split("\n");
  });

  await api.run("planreview.input.annotation-attribution", ID, async () => {
    const [handler, ...rest] = api.handlers(ID, "input");
    requireTrue(handler && rest.length === 0, "Expected one sf-planreview input hook.");
    const annotation = `# Annotations on ${REVIEW_FILE}\n\n## Annotation 1\n> Name the target org.`;
    const unmatched = (await handler(
      { type: "input", text: annotation, source: "interactive" },
      api.ctx,
    )) as {
      text?: string;
    };
    requireTrue(
      unmatched?.text?.startsWith("This review could not be matched to this Pi branch.") &&
        unmatched.text.endsWith(annotation),
      `Unmatched annotation was not flagged: ${JSON.stringify(unmatched)}`,
    );
    // Record the review source exactly as /sf-planreview does before opening a review.
    api.pi.appendEntry("sf-planreview-source", {
      reviewFile: REVIEW_FILE,
      label: "reply smoke-entry",
    });
    const matched = (await handler(
      { type: "input", text: annotation, source: "interactive" },
      api.ctx,
    )) as {
      text?: string;
    };
    requireTrue(
      matched?.text === `Review of reply smoke-entry:\n\n${annotation}`,
      `Matched annotation was not attributed: ${JSON.stringify(matched)}`,
    );
    const plain = await handler({ type: "input", text: "hello", source: "interactive" }, api.ctx);
    requireTrue(plain === undefined, "Ordinary input was transformed.");
    return { unmatched: unmatched.text?.split("\n")[0], matched: matched.text.split("\n")[0] };
  });
}
