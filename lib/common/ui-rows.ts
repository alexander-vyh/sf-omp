/* SPDX-License-Identifier: Apache-2.0 */
import { canonicalKeyId } from "@oh-my-pi/pi-coding-agent/config/keybindings/key-id";
import type {
  ExtensionRows,
  ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import { padTo, wrap } from "@oh-my-pi/pi-tui/text/width";

/** A focusable row view within the Salesforce manager's own navigation. */
export type RowsPanel = ExtensionRows & {
  render(width: number): string[];
  focused?: boolean;
  invalidate?(): void;
};

/** The actual host is OMP; non-UI extension contracts still use SF Pi types. */
export function nativeUi(ui: unknown): ExtensionUIContext {
  return ui as ExtensionUIContext;
}

const decodeContext = { kitty: false, backspaceIsCtrl: false } as const;

/** Decode a row view's raw input with OMP's own terminal decoder. */
export function decodeRowKey(data: string) {
  return decodeKey(data, decodeContext);
}

export function matchesKey(data: string, key: string): boolean {
  const event = decodeRowKey(data);
  return event !== null && event.kind !== "release" && event.id === canonicalKeyId(key);
}

export function textRows(text: string, paddingX = 0, paddingY = 0): ExtensionRows {
  const content = text.replaceAll("\t", "   ");
  const blankContent = content.trim() === "";
  let lastWidth = -1;
  let output: string[] = [];
  return {
    render(width) {
      if (width <= 0 || blankContent) return [];
      if (width === lastWidth) return output;
      lastWidth = width;
      const margin = Math.min(paddingX, Math.floor((width - 1) / 2));
      const indent = " ".repeat(margin);
      const blank = " ".repeat(width);
      output = Array<string>(paddingY).fill(blank);
      for (const row of wrap(content, width - 2 * margin)) output.push(padTo(indent + row, width));
      for (let i = 0; i < paddingY; i++) output.push(blank);
      return output;
    },
  };
}

export function stackRows(...children: ExtensionRows[]): ExtensionRows {
  return {
    render(width) {
      const rows: string[] = [];
      for (const child of children) {
        for (const row of child.render(width)) rows.push(row);
      }
      return rows;
    },
  };
}
