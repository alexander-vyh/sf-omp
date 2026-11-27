/* SPDX-License-Identifier: Apache-2.0 */
/** Compact human-facing Flow Result Card; topology renders outside the tool tile. */

import type { ExtensionRows, ExtensionTheme as Theme } from "@oh-my-pi/pi-coding-agent";
import { truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import { textRows } from "../../../lib/common/ui-rows.ts";
import type { DigestRow, FlowRunDigest, ToolResult } from "./types.ts";

export function renderFlowResult(
  result: ToolResult,
  options: { isPartial?: boolean; expanded?: boolean },
  theme: Theme,
): ExtensionRows {
  if (options.isPartial) return textRows(theme.fg("warning", "🌊 SF Flow running…"));
  const digest = asDigest(result.details?.digest);
  if (!digest) return textRows(result.content?.[0]?.text ?? "");
  return new FlowResultCard(digest, theme, options.expanded === true);
}

class FlowResultCard implements ExtensionRows {
  constructor(
    private readonly digest: FlowRunDigest,
    private readonly theme: Theme,
    private readonly expanded: boolean,
  ) {}

  render(width: number): string[] {
    const available = Math.max(12, width);
    const lines: string[] = [];
    const statusColor =
      this.digest.status === "pass"
        ? "success"
        : this.digest.status === "fail"
          ? "error"
          : this.digest.status === "warning"
            ? "warning"
            : "accent";
    const meta = [this.digest.org?.alias, ...(this.digest.meta ?? [])]
      .filter(Boolean)
      .map((value) => compactMeta(String(value)))
      .join(" · ");
    lines.push(
      this.theme.fg(
        statusColor,
        this.theme.bold(
          `${statusIcon(this.digest.status)} ${this.digest.icon} ${this.digest.title}${meta ? ` · ${meta}` : ""}`,
        ),
      ),
    );

    for (const item of (this.digest.rail ?? []).slice(0, 6)) {
      const detail = item.detail ? ` · ${item.detail}` : "";
      lines.push(this.theme.fg("dim", `   │ ${item.kind.padEnd(10)} ${item.target}${detail}`));
    }

    for (const section of this.digest.sections) {
      if (!section.rows.length) continue;
      lines.push("");
      lines.push(
        this.theme.fg("accent", this.theme.bold(`—— ${section.icon} ${section.title} ——`)),
      );
      for (const item of section.rows) lines.push(...formatRow(item, available, this.theme));
    }

    if (this.digest.artifacts?.length) {
      lines.push("");
      lines.push(this.theme.fg("accent", this.theme.bold("—— 📦 Artifacts ——")));
      const visible = this.expanded ? this.digest.artifacts : this.digest.artifacts.slice(0, 3);
      for (const artifact of visible) {
        lines.push(
          ...wrapHanging(
            this.theme.fg("muted", `  📄 ${artifact.kind.padEnd(14)} `),
            this.theme.fg("muted", artifact.path),
            available,
          ),
        );
      }
      if (visible.length < this.digest.artifacts.length) {
        lines.push(
          this.theme.fg(
            "dim",
            `  +${this.digest.artifacts.length - visible.length} more when expanded`,
          ),
        );
      }
    }

    if (this.digest.next_step) {
      lines.push("");
      lines.push(this.theme.fg("accent", this.theme.bold("—— ➡️ Next Step ——")));
      lines.push(...wrapHanging("  ", this.digest.next_step, available));
    }
    return lines.map((line) => truncate(line, width, ""));
  }
}

function formatRow(item: DigestRow, width: number, theme: Theme): string[] {
  const prefix = `  ${item.icon} ${item.label.padEnd(14)} `;
  return wrapHanging(prefix, theme.fg("toolOutput", item.value), width);
}

function wrapHanging(prefix: string, value: string, width: number): string[] {
  const prefixWidth = visibleWidth(prefix);
  const valueWidth = Math.max(8, width - prefixWidth);
  const wrapped = wrap(value, valueWidth);
  const indent = " ".repeat(Math.min(prefixWidth, Math.max(0, width - 8)));
  return wrapped.map((line, index) => (index === 0 ? `${prefix}${line}` : `${indent}${line}`));
}

function compactMeta(value: string): string {
  if (value.length <= 56 || !value.includes("/")) return value;
  const parts = value.split("/").filter(Boolean);
  return parts.length >= 2 ? `…/${parts.slice(-2).join("/")}` : value;
}

function statusIcon(status: FlowRunDigest["status"]): string {
  if (status === "pass") return "✅";
  if (status === "fail") return "❌";
  if (status === "warning") return "⚠️";
  return "ℹ️";
}

function asDigest(value: unknown): FlowRunDigest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const digest = value as Partial<FlowRunDigest>;
  if (
    typeof digest.action !== "string" ||
    typeof digest.title !== "string" ||
    !Array.isArray(digest.sections)
  ) {
    return undefined;
  }
  return digest as FlowRunDigest;
}
