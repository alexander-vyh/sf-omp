/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sf-devbar offline behavior in native OMP: real /sf-devbar and /sf-org command
 * handlers, the real before_agent_start environment injection, and the OMP bar
 * mounting path (a below-editor widget keeps the native footer intact).
 * The workspace is the smoke SFDX fixture with no default
 * org, so detection runs only the local `sf --version` and file reads.
 */
import type {
  ExtensionRows,
  ExtensionUIContext,
  ExtensionWidgetContent,
  ExtensionWidgetOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import type { SmokeApi } from "../omp-smoke-extension.ts";
import { mountWidgetRows } from "./widget-rows.ts";

const ID = "sf-devbar";

interface Note {
  message: string;
  level?: string;
}
type Widget = { view: ExtensionRows; placement?: ExtensionWidgetOptions["placement"] };

/** The genuine host ctx with notify (and optionally widget/footer calls) captured. */
function captureCtx(api: SmokeApi, options: { hasUI: boolean; widgets?: Map<string, Widget> }) {
  const notes: Note[] = [];
  const footerCalls: unknown[] = [];
  const base = api.ctx as object;
  const baseUi = Reflect.get(base, "ui") as ExtensionUIContext;
  const ui = new Proxy(baseUi, {
    get: (target, key) => {
      if (key === "notify")
        return (message: string, level?: string) => notes.push({ message, level });
      if (options.widgets && key === "setWidget")
        return (
          name: string,
          content: ExtensionWidgetContent,
          widgetOptions?: ExtensionWidgetOptions,
        ) => {
          options.widgets?.get(name)?.view.dispose?.();
          options.widgets?.delete(name);
          if (content !== undefined)
            options.widgets?.set(name, {
              view: mountWidgetRows(content, baseUi.theme, name === "sf-devbar-footer" ? 160 : 200),
              placement: widgetOptions?.placement,
            });
        };
      if (options.widgets && key === "setFooter")
        return (factory: unknown) => footerCalls.push(factory);
      if (options.widgets && (key === "setTitle" || key === "setStatus")) return () => undefined;
      return Reflect.get(target, key);
    },
  });
  const ctx = new Proxy(base, {
    get: (target, key) =>
      key === "hasUI" ? options.hasUI : key === "ui" ? ui : Reflect.get(target, key),
  });
  return { ctx, notes, footerCalls };
}

export default async function devbarChecks(api: SmokeApi): Promise<void> {
  const { requireTrue } = api;
  // `sf --version` must not start the CLI's background npm update check.
  const previousSkip = process.env.SF_SKIP_NEW_VERSION_CHECK;
  process.env.SF_SKIP_NEW_VERSION_CHECK = "true";
  try {
    const devbar = api.command("sf-devbar");
    const org = api.command("sf-org");

    await api.run("devbar.command.help-and-unknown", ID, async () => {
      requireTrue(devbar?.extension === ID, "/sf-devbar is not registered by sf-devbar.");
      const { ctx, notes } = captureCtx(api, { hasUI: false });
      await devbar.handler("help", ctx);
      await devbar.handler("bogus", ctx);
      requireTrue(
        notes[0]?.message.includes("sf-devbar — Salesforce Developer Status Bar") &&
          notes[0].message.includes("/sf-devbar toggle"),
        `Unexpected help: ${JSON.stringify(notes[0])}`,
      );
      requireTrue(
        notes[1]?.level === "warning" &&
          notes[1].message.includes("Unknown /sf-devbar subcommand: bogus"),
        `Unexpected unknown-subcommand output: ${JSON.stringify(notes[1])}`,
      );
      return notes.map((note) => note.message.split("\n")[0]);
    });

    await api.run("devbar.org.status-and-open-without-default", ID, async () => {
      requireTrue(org?.extension === ID, "/sf-org is not registered by sf-devbar.");
      const { ctx, notes } = captureCtx(api, { hasUI: false });
      await org.handler("status", ctx);
      await org.handler("open", ctx);
      const status = notes[0]?.message ?? "";
      requireTrue(
        status.startsWith("sf-org status") &&
          status.includes("Salesforce Environment Status") &&
          status.includes("Project Source API: 68.0") &&
          status.includes("no default org configured"),
        `Unexpected /sf-org status: ${status}`,
      );
      requireTrue(
        notes[1]?.level === "warning" && notes[1].message.startsWith("No default org"),
        `Unexpected /sf-org open without a default: ${JSON.stringify(notes[1])}`,
      );
      return { status: status.split("\n").slice(0, 8), open: notes[1]?.message.split("\n")[0] };
    });

    await api.run("devbar.before-agent-start.sf-environment", ID, async () => {
      const [handler, ...rest] = api.handlers(ID, "before_agent_start");
      requireTrue(handler && rest.length === 0, "Expected one sf-devbar before_agent_start hook.");
      const result = (await handler(
        { type: "before_agent_start", prompt: "", reason: "prompt" },
        api.ctx,
      )) as {
        message?: { customType?: string; content?: unknown; display?: boolean };
      };
      const content = result?.message?.content;
      requireTrue(
        result?.message?.customType === "sf-org-context" &&
          result.message.display === false &&
          typeof content === "string" &&
          content.startsWith("<sf_environment>") &&
          content.includes("(Source API 68.0)") &&
          content.includes("</sf_environment>"),
        `Unexpected environment injection: ${JSON.stringify(result)}`,
      );
      return content;
    });

    await api.run("devbar.omp.bars-mount-as-widgets", ID, async () => {
      const widgets = new Map<string, Widget>();
      const { ctx, footerCalls } = captureCtx(api, { hasUI: true, widgets });
      for (const handler of api.handlers(ID, "session_start"))
        await handler({ type: "session_start" }, ctx);
      try {
        const footer = widgets.get("sf-devbar-footer");
        const top = widgets.get("sf-devbar");
        requireTrue(footerCalls.length === 0, "sf-devbar replaced the native OMP footer.");
        requireTrue(
          footer?.placement === "belowEditor",
          "Bottom bar is not a below-editor widget.",
        );
        const bottom = stripEscapes(footer.view.render(160).join("\n"));
        const topLine = stripEscapes(top?.view.render(200).join("\n") ?? "");
        requireTrue(
          bottom.includes("SFDX Project │ Default →") && bottom.includes("No org configured"),
          `Unexpected bottom bar: ${bottom}`,
        );
        requireTrue(topLine.includes("Context Window"), `Unexpected top bar: ${topLine}`);
        return { top: topLine, bottom };
      } finally {
        for (const handler of api.handlers(ID, "session_shutdown"))
          await handler({ type: "session_shutdown" }, ctx);
        requireTrue(widgets.size === 0, "Shutdown left DevBar widgets mounted.");
      }
    });
  } finally {
    if (previousSkip === undefined) delete process.env.SF_SKIP_NEW_VERSION_CHECK;
    else process.env.SF_SKIP_NEW_VERSION_CHECK = previousSkip;
  }
}
