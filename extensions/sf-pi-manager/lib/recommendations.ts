/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Command handler for `/sf-pi recommended`.
 *
 * Nothing the Manager could install loads under the sf-omp launcher, so the
 * command lists every recommended item as unsupported with its OMP-native or
 * bundled coverage (omp-recommendations.ts) and refuses install/remove.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadRecommendationsManifest } from "../../../lib/common/catalog-state/recommendations-manifest.ts";
import { OMP_UNSUPPORTED_REASON, renderOmpRecommendations } from "./omp-recommendations.ts";

export type RecommendedSubcommand = "list" | "install" | "remove";

export interface RecommendedArgs {
  subcommand: RecommendedSubcommand;
}

/** Parse the tail after `/sf-pi recommended`; anything but install/remove lists. */
export function parseRecommendedArgs(raw: string): RecommendedArgs {
  const sub = (raw.trim().split(/\s+/)[0] ?? "").toLowerCase();
  if (sub === "install") return { subcommand: "install" };
  if (sub === "remove" || sub === "rm" || sub === "uninstall") return { subcommand: "remove" };
  return { subcommand: "list" };
}

export function handleRecommended(
  ctx: Pick<ExtensionCommandContext, "ui">,
  packageRoot: string,
  args: RecommendedArgs,
): void {
  const manifest = loadRecommendationsManifest(packageRoot);
  if (args.subcommand === "list") {
    ctx.ui.notify(renderOmpRecommendations(manifest), "info");
    return;
  }
  ctx.ui.notify(
    `/sf-pi recommended ${args.subcommand} is not supported under sf-omp. ${OMP_UNSUPPORTED_REASON}\n\n${renderOmpRecommendations(manifest)}`,
    "warning",
  );
}
