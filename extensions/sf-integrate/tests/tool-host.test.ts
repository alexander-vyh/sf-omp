/* SPDX-License-Identifier: Apache-2.0 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SfConn from "../../../lib/common/sf-conn/index.ts";
import type { SalesforceSession } from "../../../lib/common/sf-conn/index.ts";
import { createToolTestContext } from "../../../lib/common/tests/extension-tool-context.ts";
import { registerSfIntegrateTool } from "../lib/sf-integrate-tool.ts";

const connect = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/common/sf-conn/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof SfConn>()),
  connectSalesforce: connect,
}));

const session = {
  target: {
    targetOrg: "IntegrationDev",
    alias: "IntegrationDev",
    orgType: "developer",
    apiVersion: "67.0",
  },
} as unknown as SalesforceSession;

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  onUpdate: undefined,
  ctx: unknown,
) => Promise<{ isError?: boolean; details: Record<string, unknown>; content: unknown[] }>;

function registeredExecute(): Execute {
  const registerTool = vi.fn();
  registerSfIntegrateTool({ registerTool } as never);
  const definition: unknown = registerTool.mock.calls[0]?.[0];
  if (!definition || typeof definition !== "object" || !("execute" in definition)) {
    throw new Error("sf_integrate was not registered");
  }
  return definition.execute as Execute;
}

const probe = {
  action: "connection.test",
  target_org: "IntegrationDev",
  named_credential_name: "ExampleNC",
  test_path: "/health",
};

describe("sf_integrate host integration", () => {
  beforeEach(() => {
    connect.mockReset();
    connect.mockResolvedValue(session);
  });

  it("returns an untested sf_apex handoff when the host has no executeTool (OMP)", async () => {
    const execute = registeredExecute();
    const signal = new AbortController().signal;

    const result = await execute("call-1", probe, signal, undefined, { cwd: "/workspace" });

    expect(connect).toHaveBeenCalledWith({
      cwd: "/workspace",
      targetOrg: "IntegrationDev",
      signal,
    });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      ok: false,
      tested: false,
      handoff: {
        tool: "sf_apex",
        arguments: { action: "anon.run", target_org: "IntegrationDev", allow_mutation: false },
      },
    });
  });

  it("delegates the probe through ctx.executeTool when the host provides it (Pi)", async () => {
    const execute = registeredExecute();
    const signal = new AbortController().signal;
    const executeTool = vi.fn(async () => ({
      content: [{ type: "text", text: "Anonymous Apex succeeded." }],
      details: { ok: true },
    }));

    const result = await execute(
      "call-1",
      probe,
      signal,
      undefined,
      createToolTestContext({ cwd: "/workspace", executeTool }),
    );

    expect(result.details).toMatchObject({ ok: true, action: "connection.test" });
    expect(executeTool).toHaveBeenCalledWith(
      "sf_apex",
      expect.objectContaining({
        action: "anon.run",
        target_org: "IntegrationDev",
        allow_mutation: false,
        output_mode: "summary",
        body: expect.stringContaining("callout:ExampleNC/health"),
      }),
      { signal },
    );
  });

  it("fails closed before connecting when target_org is missing", async () => {
    const execute = registeredExecute();

    const result = await execute(
      "call-1",
      { action: "connection.test", named_credential_name: "ExampleNC" },
      new AbortController().signal,
      undefined,
      { cwd: "/workspace" },
    );

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      ok: false,
      error: "connection.test requires an explicit target_org.",
    });
    expect(connect).not.toHaveBeenCalled();
  });
});
