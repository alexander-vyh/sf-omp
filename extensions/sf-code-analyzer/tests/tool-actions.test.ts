/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionRows } from "@oh-my-pi/pi-coding-agent";
import type { TSchema } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NativeUiTool } from "../../../lib/common/native-ui-tool.ts";
import { createToolTestContext } from "../../../lib/common/tests/extension-tool-context.ts";
import { CODE_ANALYZER_DETAILS_KEY, registerCodeAnalyzerTool } from "../lib/code_analyzer-tool.ts";
import { createCodeAnalyzerConfirmPanel } from "../lib/manager-action-panels.ts";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "sf-code-analyzer-tool-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

type CodeAnalyzerTool = NativeUiTool<TSchema, unknown>;

function captureTool(sendUserMessage = vi.fn()): CodeAnalyzerTool {
  let tool: CodeAnalyzerTool | undefined;
  registerCodeAnalyzerTool({
    registerTool: (definition: CodeAnalyzerTool) => {
      tool = definition;
    },
    sendUserMessage,
    exec: vi.fn(),
  } as never);
  if (!tool) throw new Error("code_analyzer was not registered");
  return tool;
}

function ctx(branch: unknown[] = [], hasUI = false, confirm = vi.fn()) {
  return createToolTestContext({
    cwd,
    hasUI,
    ui: { confirm },
    sessionManager: { getBranch: () => branch },
  });
}

describe("code_analyzer tool actions", () => {
  it("renders call, progress and result rows through OMP's native renderer interface", () => {
    const tool = captureTool();
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never;

    const args = { action: "doctor" };
    const opts = { isPartial: false, expanded: false };
    const call = tool.renderCall?.(args, opts, theme) as ExtensionRows;
    expect(call.render(80).join("\n")).toContain("Code Analyzer doctor");

    const result = { content: [{ type: "text" as const, text: "Completed." }], details: {} };
    const progress = tool.renderResult?.(
      result,
      { ...opts, isPartial: true },
      theme,
      args,
    ) as ExtensionRows;
    expect(progress.render(80).join("\n")).toContain("Code Analyzer running");
    const done = tool.renderResult?.(result, opts, theme, args) as ExtensionRows;
    expect(done.render(80).join("\n")).toContain("Completed.");
  });

  it("requests a repaint when an async Manager confirmation completes", async () => {
    const requestRender = vi.fn();
    const panel = createCodeAnalyzerConfirmPanel({
      theme: {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      title: "Confirm",
      detail: "Run action",
      confirmLabel: "Run",
      onConfirm: async () => "Finished",
      done: vi.fn(),
      requestRender,
    });
    panel.handleInput?.("\r");
    expect(panel.render(80).join("\n")).toContain("Running…");
    await Promise.resolve();
    expect(requestRender).toHaveBeenCalledOnce();
    expect(panel.render(80).join("\n")).toContain("Finished");
  });

  it("returns scan recipes with structured suggestions", async () => {
    const tool = captureTool();
    const result = await tool.execute(
      "call-1",
      {
        action: "recipes",
        target: ["force-app/main/default/classes/Foo.cls"],
        output_mode: "inline",
      },
      undefined,
      undefined,
      ctx(),
    );

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const envelope = (result.details as Record<string, unknown>)[CODE_ANALYZER_DETAILS_KEY] as {
      suggestions: Array<{ id: string }>;
    };
    expect(text).toContain("SF Code Analyzer scan recipes");
    expect(envelope.suggestions.map((recipe: { id: string }) => recipe.id)).toEqual(["security"]);
  });

  it("summarizes an explicit report artifact with last_report filters", async () => {
    const report = path.join(cwd, "report.json");
    writeFileSync(
      report,
      JSON.stringify({
        runDir: cwd,
        versions: { "code-analyzer": "test" },
        violations: [
          {
            engine: "pmd",
            rule: "ApexCRUDViolation",
            severity: 2,
            primaryLocationIndex: 0,
            locations: [{ file: "classes/Foo.cls", startLine: 10, startColumn: 1 }],
            message: "Validate CRUD",
            resources: [],
          },
          {
            engine: "eslint",
            rule: "no-var",
            severity: 4,
            primaryLocationIndex: 0,
            locations: [{ file: "lwc/foo/foo.js", startLine: 1, startColumn: 1 }],
            message: "Unexpected var",
            resources: [],
          },
        ],
      }),
    );

    const tool = captureTool();
    const result = await tool.execute(
      "call-1",
      {
        action: "last_report",
        report_file: report,
        engine: "pmd",
        severity_threshold: "high",
        output_mode: "file_only",
      },
      undefined,
      undefined,
      ctx(),
    );

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const envelope = (result.details as Record<string, unknown>)[CODE_ANALYZER_DETAILS_KEY] as {
      report: { run: { violations: Array<{ rule: string }> } };
      facts: { total: number; topRules: Array<{ label: string }> };
    };
    expect(text).toContain("Violations: 1");
    expect(text).toContain(report);
    expect(envelope.report.run.violations).toHaveLength(1);
    expect(envelope.report.run.violations[0].rule).toBe("ApexCRUDViolation");
    expect(envelope.facts.total).toBe(1);
    expect(envelope.facts.topRules[0].label).toBe("ApexCRUDViolation");
  });

  it("does not queue ApexGuru browser setup follow-up when confirmation is declined", async () => {
    const sendUserMessage = vi.fn();
    const confirm = vi.fn().mockResolvedValue(false);
    const tool = captureTool(sendUserMessage);

    await tool.execute(
      "call-1",
      { action: "apexguru_setup_help", start_browser_workflow: true, target_org: "SomeOrg" },
      undefined,
      undefined,
      ctx([], true, confirm),
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("queues ApexGuru browser setup follow-up only after confirmation", async () => {
    const sendUserMessage = vi.fn();
    const confirm = vi.fn().mockResolvedValue(true);
    const tool = captureTool(sendUserMessage);

    await tool.execute(
      "call-1",
      { action: "apexguru_setup_help", start_browser_workflow: true, target_org: "SomeOrg" },
      undefined,
      undefined,
      ctx([], true, confirm),
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Use SF Browser"), {
      deliverAs: "followUp",
    });
  });
});
