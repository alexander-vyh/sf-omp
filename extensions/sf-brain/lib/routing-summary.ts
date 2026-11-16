/* SPDX-License-Identifier: Apache-2.0 */
/** Tiny runtime routing summary: one priority rule plus unavailable capability owners. */
import type { CustomMessageEntry } from "@earendil-works/pi-coding-agent";
import { SF_PI_REGISTRY } from "../../../catalog/registry.ts";
import {
  type ActiveContextSession,
  shouldInjectOnce,
} from "../../../lib/common/session/inject-once.ts";

export const SF_PI_ROUTING_ENTRY_TYPE = "sf-pi-routing-summary";
export const SF_PI_ROUTING_OPEN_TAG = "<sf_pi_routing>";
export const SF_PI_ROUTING_CLOSE_TAG = "</sf_pi_routing>";

const CAPABILITY_LABELS: Record<string, string> = {
  "sf-agentscript": "Agentforce Agent Script authoring, preview, eval, and lifecycle",
  "sf-apex": "Apex lifecycle planning, diagnostics, logs, probes, and tests",
  "sf-browser": "Salesforce Setup and Lightning UI automation",
  "sf-code-analyzer": "Salesforce static analysis and ApexGuru",
  "sf-data-explorer": "read-only SOQL, SOSL, and Data 360 exploration",
  "sf-data360": "Data 360 connect, prepare, harmonize, segment, activate, query, and observe",
  "sf-devbar": "Salesforce environment and org status",
  "sf-docs": "official Salesforce documentation retrieval",
  "sf-guardrail": "Salesforce-aware safety mediation",
  "sf-herdr": "Salesforce Herdr workflow lane planning",
  "sf-integrate": "hosted MCP OAuth integration setup",
  "sf-lsp": "Salesforce language diagnostics",
  "sf-lwc": "Lightning Web Component inspection, diagnostics, and Jest tests",
  "sf-skills": "external Salesforce skill management",
  "sf-slack": "Slack research and confirmed collaboration writes",
  "sf-soql": "schema-aware SOQL and SOSL lifecycle",
  "sf-tldraw": "editable Salesforce diagrams",
};

export function formatSfPiRoutingSummary(
  registeredToolNames: ReadonlySet<string>,
  disabledExtensions: ReadonlySet<string> = new Set(),
): string {
  // A tool owner is unavailable when none of its declared tools registered:
  // either the user disabled it, or it skipped registration (for example a
  // conditional tool surface whose prerequisites are missing).
  const unavailable = SF_PI_REGISTRY.filter(
    (extension) =>
      (extension.tools?.length ?? 0) > 0 &&
      !extension.tools?.some((tool) => registeredToolNames.has(tool)),
  );
  const lines = [
    SF_PI_ROUTING_OPEN_TAG,
    "Family tools perform the action. Skills are supplemental playbooks; they do not own the turn.",
    "Active tool definitions are authoritative. Mix families when the task needs it. Raw sf CLI is a fallback only.",
  ];
  if (unavailable.length === 0) {
    lines.push("Unavailable capability owners: none.");
  } else {
    lines.push("Unavailable capability owners:");
    for (const extension of unavailable) {
      const label = CAPABILITY_LABELS[extension.id] ?? extension.description;
      lines.push(
        disabledExtensions.has(extension.id)
          ? `- ${extension.id} — ${label}. Disabled; enable: /sf-pi enable ${extension.id}`
          : `- ${extension.id} — ${label}. Declared tools not registered.`,
      );
    }
  }
  lines.push(SF_PI_ROUTING_CLOSE_TAG);
  return lines.join("\n");
}

export function shouldInjectSfPiRoutingSummary(
  sessionManager: ActiveContextSession,
  summary: string,
): boolean {
  const stillFresh = (entry: CustomMessageEntry) => entry.content === summary;
  return shouldInjectOnce(sessionManager, SF_PI_ROUTING_ENTRY_TYPE, stillFresh);
}
