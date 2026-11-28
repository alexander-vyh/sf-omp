/* SPDX-License-Identifier: Apache-2.0 */
import { truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
export { stripEscapes as stripAnsi } from "@oh-my-pi/pi-tui/text/ansi";

export type ThemeLike = {
  bold: (s: string) => string;
  fg: (color: string, s: string) => string;
};

export function fit(text: string, width: number): string {
  return truncate(text, width);
}

export function pad(text: string, width: number): string {
  return truncate(text, width, "…", true);
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function wrapPlain(text: string, width: number, maxLines = 100): string[] {
  const rows = wrap(text, width);
  if (rows.length > maxLines) rows.length = maxLines;
  return rows;
}

export function quoteData360Identifier(identifier: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)
    ? identifier
    : `"${identifier.replace(/"/g, '""')}"`;
}

export function timestampForFile(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function safeFilePart(text: string): string {
  return (
    text
      .replace(/[^A-Za-z0-9_.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "result"
  );
}
