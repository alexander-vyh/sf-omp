/* SPDX-License-Identifier: Apache-2.0 */
/** Bounded, abortable execution of independent first-party update targets. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnCommand } from "../../../lib/common/windows-spawn.ts";
import {
  markAutoUpdateResult,
  markAutoUpdateRunning,
  type AutoUpdateStatus,
  type AutoUpdateTarget,
  type AutoUpdateTargetResult,
} from "../../../lib/common/auto-update/store.ts";
import {
  applyCheckoutUpdate,
  planCheckoutUpdate,
  type CheckoutUpdatePlan,
} from "./auto-update-checkout.ts";

const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

/** Offline runs plan nothing; otherwise the sf-omp checkout's position relative to its upstream. */
export type NativeAutoUpdatePlan =
  { offline: true } | { offline: false; checkout: CheckoutUpdatePlan };

export interface NativeAutoUpdateRunOptions {
  signal?: AbortSignal;
  canRunTarget?: (target: AutoUpdateTarget) => boolean;
  env?: NodeJS.ProcessEnv;
  onPlan?: (plan: NativeAutoUpdatePlan) => void;
  /** Checkout root override for the sf-omp checkout target (tests/fixtures). */
  checkoutRoot?: string;
}

export async function runNativeAutoUpdate(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "cwd" | "ui" | "hasUI">,
  options: NativeAutoUpdateRunOptions = {},
): Promise<AutoUpdateStatus> {
  const env = options.env ?? process.env;
  const results: AutoUpdateTargetResult[] = [
    {
      target: "pi-runtime",
      result: "skipped",
      message: "The OMP runtime is the native omp on PATH; Auto Update leaves it to `omp update`.",
    },
  ];
  let interrupted = false;
  let checkoutChanged = false;

  const setStatus = (message: string | undefined) => {
    if (ctx.hasUI) ctx.ui.setStatus("sf-pi-auto-update", message);
  };

  const mayRun = (target: AutoUpdateTarget): boolean => {
    if (options.signal?.aborted) return false;
    return options.canRunTarget?.(target) ?? true;
  };

  const runCheckoutTarget = async (): Promise<void> => {
    if (!mayRun("sf-omp-checkout")) {
      interrupted = true;
      results.push({
        target: "sf-omp-checkout",
        result: "skipped",
        message: "Skipped because the session was no longer settled or consented.",
      });
      return;
    }
    setStatus("Auto Update: checking the sf-omp checkout upstream…");
    const checkout = await planCheckoutUpdate(pi, {
      root: options.checkoutRoot,
      signal: options.signal,
    });
    options.onPlan?.({ offline: false, checkout });
    if (checkout.state !== "behind") {
      results.push({
        target: "sf-omp-checkout",
        result: checkout.state === "fetch-failed" ? "failed" : "skipped",
        message: checkout.message,
      });
      return;
    }
    if (!mayRun("sf-omp-checkout")) {
      interrupted = true;
      results.push({
        target: "sf-omp-checkout",
        result: "skipped",
        message: "Update stopped because the session was no longer settled or consented.",
      });
      return;
    }
    markAutoUpdateRunning("sf-omp-checkout");
    setStatus("Auto Update: git pull --ff-only + npm ci…");
    const applied = await applyCheckoutUpdate(pi, checkout, {
      root: options.checkoutRoot,
      signal: options.signal,
    });
    if (options.signal?.aborted && !applied.changed) interrupted = true;
    if (applied.changed) checkoutChanged = true;
    results.push({ target: "sf-omp-checkout", result: applied.result, message: applied.message });
  };

  const runSfCliTarget = async (): Promise<void> => {
    if (!mayRun("sf-cli")) {
      interrupted = true;
      results.push({
        target: "sf-cli",
        result: "skipped",
        message: "Skipped because the session was no longer settled or consented.",
      });
      return;
    }

    markAutoUpdateRunning("sf-cli");
    setStatus("Auto Update: sf update stable…");
    try {
      const [sfFile, sfArgs] = spawnCommand("sf", ["update", "stable"]);
      const result = await pi.exec(sfFile, sfArgs, {
        cwd: ctx.cwd,
        timeout: UPDATE_TIMEOUT_MS,
        signal: options.signal,
      });
      if (options.signal?.aborted || result.killed) {
        interrupted = true;
        results.push({
          target: "sf-cli",
          result: "skipped",
          message: "Cancelled when agent activity resumed or the session stopped.",
        });
      } else if (result.code === 0) {
        results.push({
          target: "sf-cli",
          result: "success",
          message: "Salesforce CLI stable-channel update completed.",
        });
      } else {
        results.push({
          target: "sf-cli",
          result: "failed",
          message: "Salesforce CLI update failed without exposing command output.",
        });
      }
    } catch {
      results.push({
        target: "sf-cli",
        result: options.signal?.aborted ? "skipped" : "failed",
        message: options.signal?.aborted
          ? "Cancelled when agent activity resumed or the session stopped."
          : "Salesforce CLI update failed without exposing command output.",
      });
      if (options.signal?.aborted) interrupted = true;
    }
  };

  try {
    if (env.PI_OFFLINE) {
      options.onPlan?.({ offline: true });
      results.push(
        {
          target: "sf-omp-checkout",
          result: "skipped",
          message: "Skipped because PI_OFFLINE is active.",
        },
        {
          target: "sf-cli",
          result: "skipped",
          message: "Skipped because PI_OFFLINE is active.",
        },
      );
    } else {
      await runCheckoutTarget();
      if (!interrupted) {
        await runSfCliTarget();
      } else {
        results.push({
          target: "sf-cli",
          result: "skipped",
          message: "Deferred because the previous target was cancelled.",
        });
      }
    }

    const failedCount = results.filter((result) => result.result === "failed").length;
    const successCount = results.filter((result) => result.result === "success").length;
    const result = interrupted
      ? "skipped"
      : failedCount > 0
        ? "failed"
        : successCount > 0
          ? "success"
          : "skipped";
    const message = interrupted
      ? "Auto Update paused because agent activity or consent changed."
      : failedCount > 0
        ? `Auto Update completed with ${failedCount} failed target(s).`
        : successCount > 0
          ? "Eligible update targets completed; the OMP runtime is updated separately with `omp update`."
          : "Auto Update skipped all network targets. The OMP runtime is updated separately with `omp update`.";

    return markAutoUpdateResult({
      result,
      message,
      targets: results,
      restartRecommended: checkoutChanged,
    });
  } finally {
    setStatus(undefined);
  }
}
