/* SPDX-License-Identifier: Apache-2.0 */
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-data-explorer";

export default async function check(api: SmokeApi): Promise<void> {
  const { requireTrue } = api;

  await api.run("data-explorer.command.help-and-mode-gate", ID, async () => {
    const command = api.command(ID);
    requireTrue(command?.extension === ID, "/sf-data-explorer not registered");
    const notes: Array<{ message: string; level?: string }> = [];
    let editor = "";
    const base = api.ctx as object;
    const baseUi = Reflect.get(base, "ui") as object;
    const ui = new Proxy(baseUi, {
      get: (target, key) => {
        if (key === "notify")
          return (message: string, level?: string) => notes.push({ message, level });
        if (key === "setEditorText")
          return (value: string) => {
            editor = value;
          };
        return Reflect.get(target, key);
      },
    });
    const ctx = new Proxy(base, {
      get: (target, key) => (key === "hasUI" ? true : key === "ui" ? ui : Reflect.get(target, key)),
    });
    const mode: unknown = Reflect.get(ctx, "mode");
    requireTrue(mode !== "tui", `smoke ctx.mode unexpectedly ${String(mode)}`);

    await command.handler("help", ctx);
    requireTrue(editor.includes("sf-data-explorer"), `help text: ${editor.slice(0, 200)}`);
    requireTrue(notes[0]?.message.includes("help copied to editor"), JSON.stringify(notes));

    await command.handler("soql Account", ctx);
    requireTrue(
      notes[1]?.level === "error" && notes[1].message.includes("requires interactive"),
      JSON.stringify(notes[1]),
    );
    return { mode, notes: notes.map((note) => note.message) };
  });

  await api.run("data-explorer.command.completions", ID, async () => {
    const command = api.command(ID);
    const top = command?.getArgumentCompletions?.("") as Array<{ value: string }> | null;
    const mode = command?.getArgumentCompletions?.("sql ") as Array<{ value: string }> | null;
    requireTrue(
      ["soql", "sosl", "sql", "default", "refresh"].every((value) =>
        top?.some((item) => item.value.trim() === value),
      ),
      JSON.stringify(top),
    );
    requireTrue(mode?.[0]?.value === "sql refresh", JSON.stringify(mode));
    return { top: top?.map((item) => item.value) };
  });

  api.skip(
    "data-explorer.tui.explorer",
    ID,
    "not-tested",
    "Explorer SPA needs interactive TUI mode plus a live org for metadata/query; smoke runs in print mode offline.",
  );
}
