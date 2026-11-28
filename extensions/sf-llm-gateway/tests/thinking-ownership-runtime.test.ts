/* SPDX-License-Identifier: Apache-2.0 */
/** Native OMP runtime proof that Gateway metadata never owns thinking selection. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { ptree } from "@oh-my-pi/pi-utils";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import {
  OMP_ISOLATION_ARGS,
  REPO_ROOT,
  ompTestHost,
  type OmpTestHost,
} from "../../../lib/common/tests/omp-host.ts";
import { API_KEY_ENV, PROVIDER_NAME } from "../lib/config.ts";

const tempDirs: string[] = [];
const servers: Server[] = [];
const extensionPath = path.join(REPO_ROOT, "extensions", "sf-llm-gateway", "index.ts");

const DISCOVERED_PRIMARY_MODEL = "gpt-4";
const DISCOVERED_SECONDARY_MODEL = "gpt-4o";

interface GatewayFixture {
  host: OmpTestHost;
  cwd: string;
  /** OMP's global config.yml: the user's `defaultThinkingLevel` and `modelRoles.default`. */
  configPath: string;
  gatewayConfigPath: string;
}

function readConfig(configPath: string): Record<string, unknown> {
  return parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

async function createFixture(thinkingLevel: "low" | "max"): Promise<GatewayFixture> {
  const root = mkdtempSync(path.join(tmpdir(), "sf-omp-thinking-runtime-"));
  tempDirs.push(root);
  const cwd = path.join(root, "workspace");
  mkdirSync(cwd);
  const host = ompTestHost(root, {
    [API_KEY_ENV]: "active-automation-test-key",
    OPENAI_API_KEY: "test-openai-key",
  });
  // The user's own OMP selection; launches pass no model or thinking flags.
  const configPath = path.join(host.agentDir, "config.yml");
  writeFileSync(
    configPath,
    stringify({ defaultThinkingLevel: thinkingLevel, modelRoles: { default: "openai/gpt-5" } }),
    "utf8",
  );

  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/v1/models") {
      response.end(
        JSON.stringify({
          data: [{ id: DISCOVERED_PRIMARY_MODEL }, { id: DISCOVERED_SECONDARY_MODEL }],
        }),
      );
      return;
    }
    if (request.url === "/v1/model/info") {
      response.end(
        JSON.stringify({
          data: [
            {
              model_name: DISCOVERED_PRIMARY_MODEL,
              model_info: {
                supports_reasoning: false,
                max_input_tokens: 200_000,
                max_output_tokens: 64_000,
              },
            },
            {
              model_name: DISCOVERED_SECONDARY_MODEL,
              model_info: {
                supports_reasoning: false,
                max_input_tokens: 128_000,
                max_output_tokens: 32_000,
              },
            },
          ],
        }),
      );
      return;
    }
    response.end("{}");
  });
  servers.push(server);
  // tsconfig's ES2022 lib has no Promise.withResolvers.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gatewayPort = (server.address() as AddressInfo).port;
  const gatewayConfigPath = path.join(host.agentDir, "sf-llm-gateway.json");
  writeFileSync(
    gatewayConfigPath,
    `${JSON.stringify({
      enabled: true,
      baseUrl: `http://127.0.0.1:${gatewayPort}`,
    })}\n`,
    "utf8",
  );

  return { host, cwd, configPath, gatewayConfigPath };
}

/** Start an RPC session on the fixture's agent dir. */
async function launch({ host, cwd }: GatewayFixture): Promise<RpcClient> {
  const client = new RpcClient({
    cwd,
    args: [...OMP_ISOLATION_ARGS, "-e", extensionPath],
    // The default spawn merges the parent environment; keep the host hermetic.
    spawn: (agentArgs) =>
      ptree.spawn([...host.command, ...agentArgs], { cwd, env: host.env, stdin: "pipe" }),
  });
  await client.start();
  return client;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Gateway thinking ownership through native OMP", () => {
  it("preserves low across startup, commands, and Gateway model switches", async () => {
    const fixture = await createFixture("low");
    const { configPath } = fixture;
    const client = await launch(fixture);
    try {
      expect((await client.getState()).thinkingLevel).toBe("low");

      for (const command of [
        "/sf-llm-gateway on global",
        "/sf-llm-gateway set-default global",
        "/sf-llm-gateway off global",
        "/sf-llm-gateway on global",
      ]) {
        await client.promptAndWait(command);
        expect(readConfig(configPath).defaultThinkingLevel, command).toBe("low");
      }

      // OMP reports no effort for a model without reasoning (Pi reported "off").
      const gatewayState = await client.getState();
      expect(gatewayState.model).toMatchObject({
        provider: PROVIDER_NAME,
        id: DISCOVERED_PRIMARY_MODEL,
      });
      expect(gatewayState.thinkingLevel).toBeUndefined();
      expect(await client.getAvailableThinkingLevels()).toEqual(["off"]);

      await client.setModel(PROVIDER_NAME, DISCOVERED_SECONDARY_MODEL);
      expect((await client.getState()).thinkingLevel).toBeUndefined();

      await client.setModel(PROVIDER_NAME, DISCOVERED_PRIMARY_MODEL);
      expect((await client.getState()).thinkingLevel).toBeUndefined();
      expect(await client.getAvailableThinkingLevels()).toEqual(["off"]);
    } finally {
      await client.stop();
    }

    expect(readConfig(configPath).defaultThinkingLevel).toBe("low");
  }, 30_000);

  it("chooses a configured non-gateway fallback when no previous default was saved", async () => {
    const fixture = await createFixture("low");
    const { configPath, gatewayConfigPath } = fixture;
    const client = await launch(fixture);
    try {
      await client.promptAndWait("/sf-llm-gateway on global");
      expect((await client.getState()).model?.provider).toBe(PROVIDER_NAME);

      const saved = JSON.parse(readFileSync(gatewayConfigPath, "utf8")) as Record<string, unknown>;
      delete saved.previousDefaultProvider;
      delete saved.previousDefaultModel;
      writeFileSync(gatewayConfigPath, `${JSON.stringify(saved)}\n`, "utf8");

      await client.promptAndWait("/sf-llm-gateway off global");
      const restored = (await client.getState()).model;
      expect(restored?.provider).toBeDefined();
      expect(restored?.provider).not.toBe(PROVIDER_NAME);
      // OMP persists the default model as config.yml `modelRoles.default`.
      expect(readConfig(configPath).modelRoles).toMatchObject({
        default: `${restored?.provider}/${restored?.id}`,
      });
    } finally {
      await client.stop();
    }
  }, 30_000);

  it("restores the previous non-gateway default while leaving OMP's thinking setting user-owned", async () => {
    const fixture = await createFixture("max");
    const { configPath } = fixture;
    const client = await launch(fixture);
    try {
      expect((await client.getState()).thinkingLevel).toBe("high");

      await client.promptAndWait("/sf-llm-gateway on global");
      const onState = await client.getState();
      expect(onState.model).toMatchObject({
        provider: PROVIDER_NAME,
        id: DISCOVERED_PRIMARY_MODEL,
      });
      expect(onState.thinkingLevel).toBeUndefined();

      await client.promptAndWait("/sf-llm-gateway off global");
      const offState = await client.getState();
      expect(offState.model).toMatchObject({ provider: "openai", id: "gpt-5" });
      // OMP carries only the live effort across model switches and the Gateway
      // model had none, so gpt-5 returns without one (Pi re-resolved "high"
      // in-session). The Gateway set no level itself: the user's `max` stays.
      expect(offState.thinkingLevel).toBeUndefined();
      expect(readConfig(configPath)).toMatchObject({
        defaultThinkingLevel: "max",
        modelRoles: { default: "openai/gpt-5" },
      });
    } finally {
      await client.stop();
    }

    // The user's setting governs the next session: gpt-5 resolves `max` to `high`.
    const restarted = await launch(fixture);
    try {
      expect(await restarted.getState()).toMatchObject({
        model: { provider: "openai", id: "gpt-5" },
        thinkingLevel: "high",
      });
    } finally {
      await restarted.stop();
    }
  }, 30_000);
});
