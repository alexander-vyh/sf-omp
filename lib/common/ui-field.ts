/* SPDX-License-Identifier: Apache-2.0 */
/** Non-secret text fields for SF Pi Manager pages that compose terminal rows. */
import { signal, UiNode, type TextEdit } from "@oh-my-pi/pi-tui";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import { paintNode, type PaintEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import "@oh-my-pi/pi-tui/term/painters/input";
import { widgetContext, type WidgetContext } from "@oh-my-pi/pi-tui/term/widgets";
import { fieldWidget } from "@oh-my-pi/pi-tui/term/widgets/editor";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

interface Options {
  placeholder?: string;
  placeholderStyle?: (text: string) => string;
  multiline?: boolean;
  maxRows?: number;
}

interface Draft {
  text: string;
  cursor: number;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const NO_CARET = { caret: "none", caretEnd: "none" } as const;
const KEY_CONTEXT = { kitty: false, backspaceIsCtrl: false };
const UNDO_LIMIT = 100;

// The field is a leaf painted into a canvas. Its caret is painted in the row,
// not as a hardware cursor on a separately focused terminal node.
const paintEnvironment: PaintEnvironment = {
  theme: currentTheme,
  clock: Date.now,
  focus: () => null,
  reduceMotion: () => true,
  hyperlinks: () => false,
};

function plainText(value: string): string {
  return stripEscapes(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

/** Reuse OMP's field widget and painter; the containing rows view owns submission and navigation. */
export class RowsTextField {
  readonly #draft = signal<Draft>({ text: "", cursor: 0 });
  readonly #focused = signal(false);
  readonly #undo: Draft[] = [];
  readonly #node: UiNode;
  readonly #widget: WidgetContext;

  constructor(private readonly options: Options = {}) {
    this.#node = new UiNode(options.multiline ? "editor" : "input", {
      text: () => this.#draft().text,
      cursor: () => this.#draft().cursor,
      maxLines: options.multiline ? (options.maxRows ?? 10) : undefined,
      term: () => (this.#focused() ? undefined : NO_CARET),
      onEdit: (edit: TextEdit) => this.#applyEdit(edit),
      onUndo: () => {
        const draft = this.#undo.pop();
        if (draft) this.#draft.set(draft);
      },
    });
    this.#widget = widgetContext([this.#node], {
      focus: () => {},
      pageRows: options.maxRows ?? 10,
    });
  }

  get focused(): boolean {
    return this.#focused.peek();
  }

  set focused(value: boolean) {
    this.#focused.set(value);
  }

  getValue(): string {
    return this.#draft.peek().text;
  }

  setValue(value: string): void {
    let text = plainText(value).replace(/\r\n?/g, "\n");
    if (!this.options.multiline) text = text.replace(/\n/g, " ");
    this.#draft.set({ text, cursor: text.length });
    this.#undo.length = 0;
  }

  handleInput(data: string): boolean {
    if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
      return this.#paste(data.slice(PASTE_START.length, -PASTE_END.length));
    }
    const key = decodeKey(data, KEY_CONTEXT);
    if (key) {
      if (this.options.multiline && key.id === "enter" && key.kind !== "release") {
        return this.#paste("\n");
      }
      if (key.kind !== "release" && key.text && /[\x00-\x1f\x7f-\x9f]/.test(key.text)) {
        return this.#paste(key.text);
      }
      return fieldWidget.key?.(this.#node, key, this.#widget) === true;
    }
    // Accept plain text bursts without interpreting unknown terminal sequences as text.
    return data.length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(data) && this.#paste(data);
  }

  render(width: number): readonly string[] {
    if (width <= 0) return [];
    const { rows } = paintNode(paintEnvironment, this.#node, width);
    if (this.#draft().text || !this.options.placeholder) return rows;

    const caret = this.#focused() ? (rows[0] ?? "") : "";
    const placeholder =
      this.options.placeholderStyle?.(this.options.placeholder) ??
      currentTheme().fg("dim", this.options.placeholder);
    return [truncate(caret + placeholder, width, "")];
  }

  dispose(): void {
    this.#node.dispose();
  }

  #paste(text: string): boolean {
    return fieldWidget.paste?.(this.#node, { text: plainText(text) }, this.#widget) === true;
  }

  #applyEdit(edit: TextEdit): void {
    const prior = this.#draft.peek();
    if (edit.len !== prior.text.length) return;
    const text =
      edit.from === edit.to && !edit.text
        ? prior.text
        : prior.text.slice(0, edit.from) + edit.text + prior.text.slice(edit.to);
    if (text !== prior.text) {
      if (this.#undo.length >= UNDO_LIMIT) this.#undo.shift();
      this.#undo.push(prior);
    } else if (edit.cursor === prior.cursor) {
      return;
    }
    this.#draft.set({ text, cursor: edit.cursor });
  }
}
