/* SPDX-License-Identifier: Apache-2.0 */
/** OMP host contract: native file dialect, exposure enforcement, and hook shapes. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import sfMcp from "../index.ts";
import { inspectMcpConfig, mcpConfigPath, setNativeMcpDialect } from "../lib/mcp-config.ts";
import {
  deactivateHiddenMcpTools,
  hiddenMcpToolNames,
  resolveMcpToolExposure,
} from "../lib/native-exposure.ts";
import { captureObservedMcpTools, getObservedMcpTools } from "../lib/observed-tools.ts";
import { getPreset } from "../lib/presets.ts";
import { installPreset, inspectPresetRuntime, setManagedPresetEnabled } from "../lib/service.ts";

const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  setNativeMcpDialect("pi");
  captureObservedMcpTools([]);
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-mcp-omp-"));
  tempDirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
  return dir;
}

/** OMP's ToolInfo for an MCP tool: minted name plus server/tool identity. */
function ompTool(server: string, tool: string) {
  return { name: `mcp__${server}_${tool}`, mcpServerName: server, mcpToolName: tool };
}

describe("SF MCP on the OMP host", () => {
  it("writes OMP's millisecond timeout and redirectUri, and reads them back unchanged", () => {
    setNativeMcpDialect("omp");
    const cwd = workspace();
    const installed = installPreset({
      cwd,
      scope: "global",
      presetId: "headless-360",
      resolution: "enable",
      setup: { environment: "sandbox", oauthClientId: "consumer-key" },
    });
    expect(installed.ok).toBe(true);

    const file = mcpConfigPath(cwd, "global");
    const onDisk = JSON.parse(readFileSync(file, "utf8")).mcpServers["salesforce-headless-360"];
    expect(onDisk.timeout).toBe(120_000);
    expect(onDisk.oauth).toMatchObject({ clientId: "consumer-key" });
    expect(onDisk.oauth.redirectUri).toMatch(/^http:\/\/(localhost|127\.0\.0\.1)/);
    expect(onDisk.oauth).not.toHaveProperty("callbackUrl");

    const inspected = inspectMcpConfig(file);
    expect(inspected.ok && inspected.servers["salesforce-headless-360"]).toMatchObject({
      timeout: 120,
      oauth: { callbackUrl: onDisk.oauth.redirectUri },
    });
    // The Pi-shaped round trip keeps the managed fingerprint, so lifecycle actions still apply.
    const preset = getPreset("headless-360");
    expect(inspectPresetRuntime(cwd, "global", preset).managed.status).toBe("managed-enabled");
    expect(
      setManagedPresetEnabled({ cwd, scope: "global", presetId: preset.id, enabled: false }).ok,
    ).toBe(true);
    expect(inspectPresetRuntime(cwd, "global", preset).managed.status).toBe("managed-disabled");
    expect(
      JSON.parse(readFileSync(file, "utf8")).mcpServers["salesforce-headless-360"],
    ).toMatchObject({ enabled: false, timeout: 120_000 });
  });

  it("keeps the host's project config directory", () => {
    expect(mcpConfigPath("/work", "project")).toBe(path.join("/work", ".pi", "mcp.json"));
  });

  it("resolves exposure like Pi: exact name, first pattern, then server default", () => {
    const policy = {
      exposure: "hidden" as const,
      toolExposure: { search: "direct" as const, "get_*": "codemode" as const },
    };
    expect(resolveMcpToolExposure(policy, "search")).toBe("direct");
    expect(resolveMcpToolExposure(policy, "get_record")).toBe("codemode");
    expect(resolveMcpToolExposure(policy, "delete_record")).toBe("hidden");
    expect(resolveMcpToolExposure({}, "anything")).toBe("codemode");
  });

  it("hides unapproved tools of a governed entry and lets a project entry shadow global", async () => {
    setNativeMcpDialect("omp");
    const cwd = workspace();
    expect(
      installPreset({ cwd, scope: "global", presetId: "trailhead", resolution: "enable" }).ok,
    ).toBe(true);
    const tools = [
      ompTool("trailhead", "content_search"),
      ompTool("trailhead", "unreviewed_write"),
      { name: "read" },
    ];
    expect([...hiddenMcpToolNames(cwd, tools)]).toEqual(["mcp__trailhead_unreviewed_write"]);

    const active = ["read", "mcp__trailhead_content_search", "mcp__trailhead_unreviewed_write"];
    const pi = {
      getAllTools: () => tools,
      getActiveTools: () => active,
      setActiveTools: vi.fn(),
    };
    await expect(deactivateHiddenMcpTools(pi, cwd)).resolves.toEqual([
      "mcp__trailhead_unreviewed_write",
    ]);
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "mcp__trailhead_content_search"]);

    expect(
      installPreset({ cwd, scope: "project", presetId: "trailhead", resolution: "enable" }).ok,
    ).toBe(true);
    expect([...hiddenMcpToolNames(cwd, tools)]).toEqual(["mcp__trailhead_unreviewed_write"]);
  });

  it("captures observed tools from OMP's MCP identity, not the minted name", () => {
    captureObservedMcpTools([
      { ...ompTool("trailhead", "content_search"), mcpReadOnlyHint: true },
      { name: "mcp__trailhead_fetch_content" },
    ]);
    expect(getObservedMcpTools(getPreset("trailhead"))).toEqual([
      { name: "content_search", annotations: { readOnlyHint: true } },
    ]);
  });

  it("blocks hidden MCP calls and appends routing as an OMP policy block", async () => {
    const cwd = workspace();
    expect(
      installPreset({ cwd, scope: "project", presetId: "trailhead", resolution: "enable" }).ok,
    ).toBe(true);
    expect(
      installPreset({
        cwd,
        scope: "project",
        presetId: "salesforce-dx",
        resolution: "side-by-side",
      }).ok,
    ).toBe(true);
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const tools = [
      ompTool("trailhead", "content_search"),
      ompTool("trailhead", "unreviewed_write"),
    ];
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
      on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        // First registration wins: the shared human-only output helper adds a later session_start.
        if (!handlers.has(event)) handlers.set(event, handler);
      }),
      events: { on: vi.fn(), emit: vi.fn() },
      getAllTools: () => tools,
      getActiveTools: () => tools.map((tool) => tool.name),
      setActiveTools: vi.fn(),
    };
    sfMcp(pi as never);
    const ctx = { cwd };

    await handlers.get("session_start")?.({ type: "session_start" }, ctx);
    expect(pi.setActiveTools).toHaveBeenCalledWith(["mcp__trailhead_content_search"]);

    const toolCall = handlers.get("tool_call");
    expect(
      await toolCall?.({ type: "tool_call", toolName: "mcp__trailhead_unreviewed_write" }, ctx),
    ).toMatchObject({ block: true });
    expect(
      await toolCall?.({ type: "tool_call", toolName: "mcp__trailhead_content_search" }, ctx),
    ).toBeUndefined();

    const prepared = (await handlers.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        systemPrompt: ["base", "<sf_mcp_routing>\nstale\n</sf_mcp_routing>"],
      },
      ctx,
    )) as { systemPrompt: string[] };
    expect(prepared.systemPrompt[0]).toBe("base");
    expect(prepared.systemPrompt).toHaveLength(2);
    expect(prepared.systemPrompt[1]).toMatch(
      /^<sf_mcp_routing>\n- Salesforce DX MCP is enabled side-by-side[\s\S]*<\/sf_mcp_routing>$/,
    );
  });
});
