/* SPDX-License-Identifier: Apache-2.0 */
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { describe, expect, it } from "vitest";
import { RowsTextField } from "../ui-field.ts";

const HOME = "\x1b[H";
const END = "\x1b[F";
const LEFT = "\x1b[D";
const UP = "\x1b[A";
const ERASE = "\x7f";
const UNDO = "\x1f";

function paste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

describe("RowsTextField", () => {
  it("reuses the OMP field's grapheme motions and native undo", () => {
    const field = new RowsTextField();
    field.setValue("a👩‍🚒b");
    field.handleInput(LEFT);
    field.handleInput(ERASE);
    expect(field.getValue()).toBe("ab");
    field.handleInput(UNDO);
    expect(field.getValue()).toBe("a👩‍🚒b");
    field.handleInput(HOME);
    field.handleInput("^");
    field.handleInput(END);
    field.handleInput("!");
    expect(field.getValue()).toBe("^a👩‍🚒b!");
    field.dispose();
  });

  it("displays the focused caret in the visible slice and leaves escape controls out of pasted text", () => {
    const field = new RowsTextField({ placeholder: "Type here" });
    expect(field.render(20).map(stripEscapes)).toEqual(["Type here"]);
    field.focused = true;
    expect(field.render(20).map(stripEscapes)).toEqual(["▏Type here"]);
    field.handleInput(paste("alphabet\r\n世界\x1b[31m!\x07"));
    expect(field.getValue()).toBe("alphabet 世界!");
    const [row = ""] = field.render(6);
    expect(visibleWidth(row)).toBeLessThanOrEqual(6);
    expect(stripEscapes(row)).toContain("!▏");
    field.dispose();
  });

  it("edits multiline drafts at the caret and paints wrapped rows without embedded newlines", () => {
    const field = new RowsTextField({ multiline: true, maxRows: 4 });
    field.focused = true;
    field.handleInput("first");
    field.handleInput("\r");
    field.handleInput("second");
    field.render(20); // Paint before vertical navigation, as the Manager does.
    field.handleInput(UP);
    field.handleInput(END);
    field.handleInput("!");
    expect(field.getValue()).toBe("first!\nsecond");
    const rows = field.render(4);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => visibleWidth(row) <= 4 && !row.includes("\n"))).toBe(true);
    field.dispose();
  });
});
