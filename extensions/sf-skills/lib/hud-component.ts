/* SPDX-License-Identifier: Apache-2.0 */
/** Right-aligned, passive composer widget for skills in context. */
import type { ExtensionTheme } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { SkillsHudState } from "./skill-state.ts";

export function renderSkillsHud(
  width: number,
  theme: ExtensionTheme,
  state: SkillsHudState,
): string[] {
  if (width < 3 || state.live.length === 0) return [];
  const hudWidth = Math.min(width, Math.max(36, Math.floor(width * 0.3)));
  const left = " ".repeat(Math.max(0, width - hudWidth - 2));
  const inner = hudWidth - 2;
  const side = theme.fg("border", "│");
  const rule = "─".repeat(inner);
  const row = (text: string) => `${left}${side}${truncate(text, inner, "", true)}${side}`;

  const title = theme.fg("accent", theme.bold("🔒 SF Skills HUD"));
  const summary = theme.fg("dim", `${state.live.length} in context`);
  const gap = Math.max(1, inner - visibleWidth(title) - visibleWidth(summary));
  const prefix = "In context: ";
  const skills = wrapSkillList(
    prefix,
    state.live.map((skill) => skill.name),
    inner,
  );
  return [
    left + theme.fg("border", `╭${rule}╮`),
    row(`${title}${" ".repeat(gap)}${summary}`),
    ...skills.map((line, index) =>
      row(index === 0 ? theme.fg("accent", prefix) + line.slice(prefix.length) : line),
    ),
    left + theme.fg("border", `╰${rule}╯`),
  ];
}

function wrapSkillList(prefix: string, names: string[], width: number): string[] {
  const indent = " ".repeat(prefix.length);
  const lines: string[] = [];
  let current = prefix;

  for (let index = 0; index < names.length; index++) {
    const isLast = index === names.length - 1;
    const token = isLast ? names[index] : `${names[index]}, `;

    if (visibleWidth(current + token) <= width) {
      current += token;
      continue;
    }

    lines.push(current.trimEnd());
    current = indent + token;
  }

  lines.push(current.trimEnd());
  return lines;
}
