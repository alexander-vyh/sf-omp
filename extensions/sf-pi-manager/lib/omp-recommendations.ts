/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Recommended Pi packages on the OMP host.
 *
 * The sf-omp launcher starts OMP explicit-only (`--no-extensions -e <checkout>`),
 * a mode in which OMP loads neither installed OMP plugins nor Pi packages, so
 * neither `pi install` nor `omp plugin install` can make a recommendation
 * active. Each item is therefore reported as unsupported, naming the OMP-native
 * or bundled capability that covers it where one exists.
 */
import type { RecommendationsManifest } from "../../../catalog/types.ts";

export const OMP_UNSUPPORTED_REASON =
  "sf-omp launches OMP explicit-only (--no-extensions -e <checkout>), so packages installed with `pi install` or `omp plugin install` are never loaded.";

/** OMP-native or bundled coverage for each recommended item, keyed by manifest id. */
const OMP_COVERAGE: Record<string, string> = {
  "pi-skills":
    "Clone the collection and add it as a skill source with /sf-skills (native skills.customDirectories).",
  "pi-web-access": "OMP's native web search and fetch tools.",
  "pi-fff": "OMP's native grep and glob tools.",
  "pi-aliases": "OMP's built-in /clear and /exit commands.",
  "pi-interview": "OMP's native ask tool.",
  "pi-tool-display": "OMP's native tool-call rendering.",
  "pi-subagents": "OMP's native task subagents.",
  "pi-herdr": "The bundled sf-herdr extension.",
};

export function ompRecommendationCoverage(id: string): string {
  return OMP_COVERAGE[id] ?? "No OMP-native equivalent; not available under sf-omp.";
}

/** Status/list text for every recommended item on the OMP host. */
export function renderOmpRecommendations(manifest: RecommendationsManifest): string {
  const ids = Object.keys(manifest.items).sort();
  return [
    `Recommended extensions (OMP host): ${ids.length} unsupported`,
    `Reason: ${OMP_UNSUPPORTED_REASON}`,
    "",
    ...ids.flatMap((id) => [
      `  ✗ ${id} (${manifest.items[id]?.source ?? "unknown source"})`,
      `      Under OMP: ${ompRecommendationCoverage(id)}`,
    ]),
  ].join("\n");
}
