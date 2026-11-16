/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Enforces Pi's `hidden` MCP tool exposure on hosts that ignore it.
 *
 * OMP loads mcp.json entries but drops Pi's `exposure`/`toolExposure` fields, so
 * every tool of a governed server would otherwise be callable. OMP describes
 * each MCP tool with `mcpServerName`/`mcpToolName`; SF MCP resolves those
 * against the native entry's reviewed policy. Only `hidden` changes behavior:
 * OMP has no codemode/deferred tiers, so other exposures keep OMP's default.
 * Pi reports no MCP identity on tools and enforces exposure natively, so this
 * is inert there.
 */
import { inspectMcpConfig, mcpConfigPath, type McpExposure } from "./mcp-config.ts";

export interface McpToolIdentity {
  name: string;
  mcpServerName?: string;
  mcpToolName?: string;
}

interface ExposurePolicy {
  exposure?: McpExposure;
  toolExposure?: Record<string, McpExposure>;
}

/** Pi's resolution: exact name, then the first matching `*` pattern, then the server default. */
export function resolveMcpToolExposure(policy: ExposurePolicy, toolName: string): McpExposure {
  const overrides = policy.toolExposure ?? {};
  const exact = overrides[toolName];
  if (exact) return exact;
  for (const [pattern, exposure] of Object.entries(overrides)) {
    if (pattern.includes("*") && wildcard(pattern).test(toolName)) return exposure;
  }
  return policy.exposure ?? "codemode";
}

/** Registered MCP tool names whose native entry policy resolves to `hidden`. */
export function hiddenMcpToolNames(cwd: string, tools: readonly McpToolIdentity[]): Set<string> {
  const hidden = new Set<string>();
  const identified = tools.filter((tool) => tool.mcpServerName && tool.mcpToolName);
  if (identified.length === 0) return hidden;
  const policies = effectivePolicies(cwd);
  for (const tool of identified) {
    const policy = policies.get(tool.mcpServerName ?? "");
    if (policy && resolveMcpToolExposure(policy, tool.mcpToolName ?? "") === "hidden") {
      hidden.add(tool.name);
    }
  }
  return hidden;
}

/** Removes policy-hidden MCP tools from the host's active set so the model never sees them. */
export async function deactivateHiddenMcpTools(
  pi: {
    getAllTools(): readonly McpToolIdentity[];
    getActiveTools(): string[];
    setActiveTools(names: string[]): void | Promise<void>;
  },
  cwd: string,
): Promise<string[]> {
  const hidden = hiddenMcpToolNames(cwd, pi.getAllTools());
  if (hidden.size === 0) return [];
  const active = pi.getActiveTools();
  const removed = active.filter((name) => hidden.has(name));
  if (removed.length > 0) await pi.setActiveTools(active.filter((name) => !hidden.has(name)));
  return removed;
}

/** OMP precedence: a project entry shadows the global entry of the same name. */
function effectivePolicies(cwd: string): Map<string, ExposurePolicy> {
  const policies = new Map<string, ExposurePolicy>();
  for (const scope of ["global", "project"] as const) {
    const inspected = inspectMcpConfig(mcpConfigPath(cwd, scope));
    if (inspected.ok === false) continue;
    for (const [name, entry] of Object.entries(inspected.servers)) {
      if (entry.exposure !== undefined || entry.toolExposure !== undefined) {
        policies.set(name, { exposure: entry.exposure, toolExposure: entry.toolExposure });
      } else {
        policies.delete(name);
      }
    }
    for (const [name, override] of Object.entries(inspected.overrides)) {
      const base = policies.get(name) ?? {};
      policies.set(name, {
        exposure: override.exposure ?? base.exposure,
        toolExposure: override.toolExposure ?? base.toolExposure,
      });
    }
  }
  return policies;
}

function wildcard(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}
