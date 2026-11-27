/* SPDX-License-Identifier: Apache-2.0 */
/** Explicit entry point for the local-first Eval Studio overlay. */

import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { emitHumanOnlyCommandOutput } from "../../../../lib/common/human-only-command-output.ts";
import { resolveUiGlyphs } from "../../../../lib/common/ui-glyphs.ts";
import { nativeUi } from "../../../../lib/common/ui-rows.ts";
import { latestEvalSpec } from "../branch-state.ts";
import { evalProjectRoot, resolveRunDir } from "../eval/persist.ts";
import { readEvalRunArtifact } from "./artifact-reader.ts";
import { EvalStudioComponent, type EvalStudioIntent } from "./component.ts";
import { discoverEvalStudio, renderInventorySummary } from "./discovery.ts";
import { activeStudioRun } from "./run-coordinator.ts";

export const EVAL_STUDIO_OUTPUT_TYPE = "sf-agentscript-eval-studio-output";

export async function openEvalStudio(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<EvalStudioIntent | undefined> {
  const branchSpec = (ctx as ExtensionContext).sessionManager
    ? latestEvalSpec(ctx as ExtensionContext)
    : undefined;
  const discoveryOptions = {
    branch_specs: branchSpec
      ? [{ spec_path: branchSpec.spec_path, agent_file: branchSpec.agent_file }]
      : [],
  };
  let inventory = await discoverEvalStudio(ctx.cwd, discoveryOptions);
  if (ctx.mode !== "tui") {
    await emitHumanOnlyCommandOutput(pi, ctx, EVAL_STUDIO_OUTPUT_TYPE, {
      title: "Agent Script Eval Studio",
      body: renderInventorySummary(inventory),
      severity: inventory.issues.length ? "warning" : "info",
    });
    return undefined;
  }

  // OMP owns overlay focus and teardown through custom(); no private loader visibility API.
  for (;;) {
    let result: EvalStudioIntent | undefined;
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    const signal = ctx.signal;
    try {
      result = await nativeUi(ctx.ui).custom<EvalStudioIntent>(
        (ui, theme, _keybindings, done) => {
          const finish = (value: EvalStudioIntent): void => {
            if (refreshTimer) clearInterval(refreshTimer);
            done(value);
          };
          const activeRunId = activeStudioRun(ctx.cwd);
          const component = new EvalStudioComponent(
            theme,
            inventory,
            resolveUiGlyphs(ctx.cwd),
            finish,
            () => ui.size().rows,
            activeRunId,
          );
          if (activeRunId) {
            refreshTimer = setInterval(() => {
              void readEvalRunArtifact(resolveRunDir(ctx.cwd, activeRunId), { details: true }).then(
                (artifact) => {
                  const summary = artifact.summary;
                  const resolvedSuitePath = summary.suite_path
                    ? path.normalize(
                        path.isAbsolute(summary.suite_path)
                          ? summary.suite_path
                          : path.resolve(evalProjectRoot(ctx.cwd), summary.suite_path),
                      )
                    : undefined;
                  const assignedSuiteId = inventory.suites.find(
                    (suite) =>
                      resolvedSuitePath && path.normalize(suite.path) === resolvedSuitePath,
                  )?.id;
                  inventory = {
                    ...inventory,
                    suites: inventory.suites.map((suite) => {
                      const existing = suite.runs.find((run) => run.run_id === activeRunId);
                      if (existing) {
                        return {
                          ...suite,
                          runs: suite.runs.map((run) =>
                            run.run_id === activeRunId
                              ? { ...summary, stale_source: run.stale_source }
                              : run,
                          ),
                        };
                      }
                      return suite.id === assignedSuiteId
                        ? { ...suite, runs: [summary, ...suite.runs] }
                        : suite;
                    }),
                    unassigned_runs: assignedSuiteId
                      ? inventory.unassigned_runs.filter((run) => run.run_id !== activeRunId)
                      : inventory.unassigned_runs.some((run) => run.run_id === activeRunId)
                        ? inventory.unassigned_runs.map((run) =>
                            run.run_id === activeRunId ? summary : run,
                          )
                        : [summary, ...inventory.unassigned_runs],
                  };
                  component.replaceInventory(inventory);
                  ui.requestRender();
                },
              );
            }, 750);
            refreshTimer.unref?.();
          }
          return component;
        },
        { overlay: true, fullscreen: true, signal },
      );
    } catch (error) {
      if (signal?.aborted && error === signal.reason) return undefined;
      throw error;
    } finally {
      if (refreshTimer) clearInterval(refreshTimer);
    }

    if (!result || result.kind === "close") return undefined;
    if (result.kind === "refresh") {
      inventory = await discoverEvalStudio(ctx.cwd, discoveryOptions);
      continue;
    }
    return result;
  }
}
