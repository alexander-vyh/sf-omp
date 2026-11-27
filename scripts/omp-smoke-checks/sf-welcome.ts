/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sf-welcome offline behavior in native OMP: real /sf-welcome and
 * /sf-setup-fonts handlers (headless paths print or notify), and the startup
 * splash on OMP whose session_start carries no reason. The splash mounts as
 * an above-editor widget for a new session and dismisses on agent_start. The
 * font installer itself is not run: on macOS it clears the user's system font
 * cache (atsutil), outside the smoke sandbox.
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

const ID = "sf-welcome";

interface Note {
  message: string;
  level?: string;
}
type Widget = { view: ExtensionRows; placement?: ExtensionWidgetOptions["placement"] };

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

export default async function welcomeChecks(api: SmokeApi): Promise<void> {
  const { requireTrue } = api;
  const base = api.ctx as object;
  const baseUi = Reflect.get(base, "ui") as ExtensionUIContext;
  const notes: Note[] = [];
  const notifyUi = new Proxy(baseUi, {
    get: (target, key) =>
      key === "notify"
        ? (message: string, level?: string) => notes.push({ message, level })
        : Reflect.get(target, key),
  });
  const headless = new Proxy(base, {
    get: (target, key) =>
      key === "hasUI" ? false : key === "ui" ? notifyUi : Reflect.get(target, key),
  });

  await api.run("welcome.command.help-and-summary", ID, async () => {
    const command = api.command("sf-welcome");
    requireTrue(command?.extension === ID, "/sf-welcome is not registered by sf-welcome.");
    const help = await captureInfo(() => command.handler("help", headless));
    const summary = await captureInfo(() => command.handler("summary", headless));
    requireTrue(
      help[0]?.startsWith("sf-welcome — splash summary") && help[0].includes("/sf-welcome summary"),
      `Unexpected help: ${JSON.stringify(help)}`,
    );
    const text = summary[0] ?? "";
    requireTrue(
      text.includes("sf-pi Welcome Summary") &&
        text.includes("Provider: openai") &&
        text.includes("sf-pi Extensions:") &&
        text.includes("● DevBar — active"),
      `Unexpected summary: ${text.slice(0, 600)}`,
    );
    return { help: help[0]?.split("\n")[0], summary: text.split("\n").slice(0, 6) };
  });

  await api.run("welcome.setup-fonts.help-and-status", ID, async () => {
    const command = api.command("sf-setup-fonts");
    requireTrue(command?.extension === ID, "/sf-setup-fonts is not registered by sf-welcome.");
    notes.length = 0;
    await command.handler("help", headless);
    await command.handler("status", headless);
    requireTrue(
      notes[0]?.message.includes("/sf-setup-fonts install") &&
        notes[1]?.message.startsWith("sf-setup-fonts status") &&
        notes[1].message.includes("MesloLGM Nerd Font Mono") &&
        notes[1].message.includes(`Platform       ${process.platform}`),
      `Unexpected font command output: ${JSON.stringify(notes)}`,
    );
    return notes.map((note) => note.message.split("\n").slice(0, 5));
  });

  await api.run("welcome.omp.splash-widget-and-dismiss", ID, async () => {
    const widgets = new Map<string, Widget>();
    const headerCalls: unknown[] = [];
    const ui = new Proxy(baseUi, {
      get: (target, key) => {
        if (key === "setWidget")
          return (
            name: string,
            content: ExtensionWidgetContent,
            options?: ExtensionWidgetOptions,
          ) => {
            widgets.get(name)?.view.dispose?.();
            widgets.delete(name);
            if (content !== undefined)
              widgets.set(name, {
                view: mountWidgetRows(content, baseUi.theme, 140),
                placement: options?.placement,
              });
          };
        if (key === "setHeader") return (factory: unknown) => headerCalls.push(factory);
        if (key === "onTerminalInput") return () => () => undefined;
        if (key === "confirm") return async () => false;
        if (key === "notify") return () => undefined;
        return Reflect.get(target, key);
      },
    });
    const ctx = new Proxy(base, {
      get: (target, key) => (key === "hasUI" ? true : key === "ui" ? ui : Reflect.get(target, key)),
    });
    // OMP's own session_start payload: no reason field.
    for (const handler of api.handlers(ID, "session_start"))
      await handler({ type: "session_start" }, ctx);
    const splash = widgets.get("sf-welcome");
    requireTrue(headerCalls.length === 0, "sf-welcome replaced the native OMP header.");
    requireTrue(splash?.placement === "aboveEditor", "Splash is not an above-editor widget.");
    const rendered = stripEscapes(splash.view.render(140).join("\n"));
    requireTrue(
      rendered.includes("Welcome back!") && rendered.includes("Press Esc to dismiss"),
      `Unexpected splash: ${rendered.slice(0, 400)}`,
    );
    for (const handler of api.handlers(ID, "agent_start"))
      await handler({ type: "agent_start" }, ctx);
    requireTrue(!widgets.has("sf-welcome"), "agent_start did not dismiss the splash widget.");
    return { lines: rendered.split("\n").length, dismissedOnAgentStart: true };
  });
}
