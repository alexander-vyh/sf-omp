/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sf-fin offline behavior in native OMP. `/login sf-fin*` runs through OMP's
 * real OAuth login pipeline into its hermetic credential store with synthetic
 * tokens. Fin region discovery and Agent API probes hit the harness fetch
 * blocker (recorded as blocked fetches), so no request leaves the process.
 */
import type { SmokeApi } from "../omp-smoke-extension.ts";

const EXTENSION = "sf-fin";
const PERSONAL_TOKEN = "omp-smoke-fin-personal-fixture";
const AGENT_KEY = "omp-smoke-fin-agent-key-fixture";
const NAMED_WORKSPACE = "ompsmoke";
const NAMED_TOKEN = "omp-smoke-fin-named-fixture";
const MCP_WORKSPACE = "ompsmcp";

interface LoginPrompt {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
  secret?: boolean;
}

interface SmokeAuthStorage {
  oauth: {
    login(
      provider: string,
      controller: {
        onAuth(info: { url: string }): void;
        onProgress(message: string): void;
        onPrompt(prompt: LoginPrompt): Promise<string>;
      },
    ): Promise<unknown>;
  };
  credentials: {
    get(provider: string): Record<string, unknown> | undefined;
    remove(provider: string): Promise<void>;
  };
}

interface SmokeContext {
  modelRegistry: { authStorage: SmokeAuthStorage };
}

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

async function commandOutput(api: SmokeApi, args: string): Promise<string> {
  const command = api.command("sf-fin");
  api.requireTrue(command?.extension === EXTENSION, "Expected /sf-fin from sf-fin.");
  const lines: string[] = [];
  const original = console.info;
  console.info = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try {
    await command.handler(args, api.ctx);
    return lines.join("\n");
  } finally {
    console.info = original;
  }
}

/** Drive OMP's real `/login <provider>` pipeline with scripted answers. */
async function login(
  authStorage: SmokeAuthStorage,
  provider: string,
  answers: string[],
): Promise<{ prompts: LoginPrompt[]; progress: string[]; error?: string }> {
  const prompts: LoginPrompt[] = [];
  const progress: string[] = [];
  try {
    await authStorage.oauth.login(provider, {
      onAuth: () => undefined,
      onProgress: (message) => progress.push(message),
      onPrompt: async (prompt) => {
        prompts.push(prompt);
        return answers.shift() ?? "";
      },
    });
    return { prompts, progress };
  } catch (error) {
    return { prompts, progress, error: error instanceof Error ? error.message : String(error) };
  }
}

export default async function sfFinChecks(api: SmokeApi): Promise<void> {
  const authStorage = (api.ctx as SmokeContext).modelRegistry.authStorage;

  await api.run("fin.unconfigured.status", EXTENSION, async () => {
    api.requireTrue(
      !process.env.INTERCOM_TOKEN && !process.env.FIN_AGENT_API_KEY,
      "Fin automation env leaked into the smoke process.",
    );
    const status = text(await api.invoke("sf_fin", { action: "status" }));
    api.requireTrue(
      status.includes("Credential: not connected") && status.includes("Region: US (default)"),
      `Expected unconfigured status: ${status}`,
    );
    const command = await commandOutput(api, "status");
    api.requireTrue(
      command.includes("Credential: not connected"),
      `/sf-fin status did not report unconfigured: ${command}`,
    );
    return status.split("\n").slice(2, 5);
  });

  await api.run("fin.login.personal.native", EXTENSION, async () => {
    // Region discovery cannot reach Fin offline, so login falls back to the region choice.
    const result = await login(authStorage, "sf-fin", [PERSONAL_TOKEN, "2"]);
    api.requireTrue(!result.error, `Personal login failed: ${result.error}`);
    api.requireTrue(
      result.prompts[0]?.secret === true &&
        result.prompts[1]?.secret !== true &&
        result.prompts[1]?.message.includes("1) US") &&
        result.prompts[1]?.message.includes("2) EU"),
      `Expected masked token then region choice: ${JSON.stringify(result.prompts)}`,
    );
    const stored = authStorage.credentials.get("sf-fin");
    const env = stored?.env as Record<string, unknown> | undefined;
    api.requireTrue(
      stored?.sfPiCredential === "api_key" &&
        stored.access === PERSONAL_TOKEN &&
        env?.INTERCOM_REGION === "eu",
      "OMP did not persist the personal token with its region.",
    );
    return {
      prompts: result.prompts.map(({ message, secret }) => ({
        message: message.split("\n")[0],
        secret: secret === true,
      })),
      region: env.INTERCOM_REGION,
    };
  });

  await api.run("fin.configured.status", EXTENSION, async () => {
    const status = text(await api.invoke("sf_fin", { action: "status" }));
    api.requireTrue(
      status.includes("Credential: saved by /login sf-fin") &&
        status.includes("Region: EU (pi-auth)") &&
        !status.includes(PERSONAL_TOKEN),
      `Expected configured status from the OMP store: ${status}`,
    );
    const command = await commandOutput(api, "status");
    api.requireTrue(
      command.includes("Credential: saved by /login sf-fin"),
      `/sf-fin status did not report the saved credential: ${command}`,
    );
    return status.split("\n").slice(2, 5);
  });

  await api.run("fin.login.agent.native", EXTENSION, async () => {
    const short = await login(authStorage, "sf-fin-agent", ["too-short"]);
    api.requireTrue(short.error?.includes("too short"), `Expected shape rejection: ${short.error}`);
    const swapped = await login(authStorage, "sf-fin-agent", [PERSONAL_TOKEN]);
    api.requireTrue(
      swapped.error?.includes("That is the personal API token"),
      `Expected personal-token separation check: ${swapped.error}`,
    );
    api.requireTrue(
      authStorage.credentials.get("sf-fin-agent") === undefined,
      "A rejected Agent API login must not persist anything.",
    );
    const saved = await login(authStorage, "sf-fin-agent", [AGENT_KEY]);
    api.requireTrue(!saved.error, `Agent key login failed: ${saved.error}`);
    api.requireTrue(saved.prompts[0]?.secret === true, "Agent key prompt was not masked.");
    api.requireTrue(
      authStorage.credentials.get("sf-fin-agent")?.access === AGENT_KEY,
      "OMP did not persist the Agent API key.",
    );
    return { short: short.error, swapped: swapped.error, saved: true };
  });

  await api.run("fin.agent.access.network-boundary", EXTENSION, async () => {
    const result = await api.invoke("sf_fin", { action: "agent", operation: "access" });
    const details = api.details(result);
    // The key resolved from the OMP store (not phase "credential"); the probe then
    // reaches the blocked network boundary.
    api.requireTrue(
      details.phase !== "credential" && !JSON.stringify(result).includes(AGENT_KEY),
      `Agent access did not get past credential resolution: ${JSON.stringify(result)}`,
    );
    return { ok: details.ok, phase: details.phase, access: details.access };
  });

  await api.run("fin.setup.read-only", EXTENSION, async () => {
    const result = await api.invoke("sf_fin", { action: "setup" });
    const details = api.details(result);
    const body = text(result);
    api.requireTrue(
      details.phase === "setup" && details.workspace === "default",
      `Unexpected setup result: ${JSON.stringify(result)}`,
    );
    api.requireTrue(
      !body.includes(PERSONAL_TOKEN) && !body.includes(AGENT_KEY),
      "Setup leaked a credential.",
    );
    return { ok: details.ok, ready: details.ready, steps: details.steps };
  });

  await api.run("fin.setup.mcp-detection", EXTENSION, async () => {
    const connection = `intercom-${MCP_WORKSPACE}`;
    const setup = async () =>
      await api.invoke("sf_fin", {
        action: "setup",
        workspace: MCP_WORKSPACE,
        wants: ["operator"],
      });
    const added = await api.invoke("sf_fin", {
      action: "workspace",
      operation: "add",
      name: MCP_WORKSPACE,
      kind: "test",
    });
    api.requireTrue(api.details(added).ok === true, `Workspace add failed: ${text(added)}`);
    try {
      const without = await setup();
      api.requireTrue(
        text(without).includes(`Intercom MCP (${connection}) | — not configured`) &&
          text(without).includes(`/mcp reauth ${connection}`) &&
          (api.details(without).ready as Record<string, unknown>).operator === false,
        `Expected an unconfigured MCP before the fixture tool exists: ${text(without)}`,
      );
      // Fixture standing in for the tool OMP's MCP runtime registers for the
      // connection: same provenance fields getAllTools() reports for MCP tools.
      api.pi.registerTool({
        name: `mcp__intercom_${MCP_WORKSPACE}_list_articles`,
        label: "Intercom list_articles (smoke fixture)",
        description: "Smoke fixture for an OMP-exposed Intercom MCP tool; never called.",
        parameters: { type: "object", properties: {} } as never,
        mcpServerName: connection,
        mcpToolName: "list_articles",
        execute: async () => {
          throw new Error("The Intercom MCP smoke fixture must not be called.");
        },
      } as never);
      // OMP activates runtime-registered tools asynchronously.
      let listed;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        listed = api.pi
          .getAllTools()
          .find((tool) => tool.name === `mcp__intercom_${MCP_WORKSPACE}_list_articles`);
        if (listed) break;
        await Bun.sleep(100);
      }
      api.requireTrue(
        listed?.mcpServerName === connection && listed.mcpToolName === "list_articles",
        `OMP did not report the fixture's MCP provenance: ${JSON.stringify(listed)}`,
      );
      const withTool = await setup();
      api.requireTrue(
        text(withTool).includes(`Intercom MCP (${connection}) | ✅ connected (tools available)`) &&
          (api.details(withTool).ready as Record<string, unknown>).operator === true &&
          !text(withTool).includes("/mcp reauth"),
        `Expected the OMP-exposed MCP connection to be detected: ${text(withTool)}`,
      );
      return {
        without: text(without)
          .split("\n")
          .find((line) => line.startsWith("Intercom MCP")),
        withTool: text(withTool)
          .split("\n")
          .find((line) => line.startsWith("Intercom MCP")),
      };
    } finally {
      await api.invoke("sf_fin", { action: "workspace", operation: "remove", name: MCP_WORKSPACE });
    }
  });

  await api.run("fin.browser-signin.boundary", EXTENSION, async () => {
    const result = await login(authStorage, "sf-fin-browser", []);
    api.requireTrue(
      result.error?.includes("has no verified app id yet"),
      `Expected unverified-workspace refusal before any browser opens: ${result.error}`,
    );
    api.requireTrue(
      authStorage.credentials.get("sf-fin-browser") === undefined,
      "Nothing may be stored when sign-in is refused.",
    );
    return result.error;
  });

  await api.run("fin.workspace.runtime-provider", EXTENSION, async () => {
    const added = await api.invoke("sf_fin", {
      action: "workspace",
      operation: "add",
      name: NAMED_WORKSPACE,
      kind: "test",
    });
    api.requireTrue(api.details(added).ok === true, `Workspace add failed: ${text(added)}`);
    try {
      // The workspace's providers are registered at runtime, without a reload.
      const result = await login(authStorage, `sf-fin-${NAMED_WORKSPACE}`, [NAMED_TOKEN, "3"]);
      api.requireTrue(!result.error, `Named workspace login failed: ${result.error}`);
      const env = authStorage.credentials.get(`sf-fin-${NAMED_WORKSPACE}`)?.env as
        Record<string, unknown> | undefined;
      api.requireTrue(env?.INTERCOM_REGION === "au", "Named workspace region was not stored.");
      const listed = text(await api.invoke("sf_fin", { action: "workspace", operation: "list" }));
      api.requireTrue(listed.includes(NAMED_WORKSPACE), `Workspace not listed: ${listed}`);
      const setup = api.details(
        await api.invoke("sf_fin", { action: "setup", workspace: NAMED_WORKSPACE }),
      );
      api.requireTrue(setup.workspace === NAMED_WORKSPACE, "Setup ignored the named workspace.");
      return { region: env.INTERCOM_REGION, listed: listed.split("\n").slice(0, 4) };
    } finally {
      await authStorage.credentials.remove(`sf-fin-${NAMED_WORKSPACE}`);
      await api.invoke("sf_fin", {
        action: "workspace",
        operation: "remove",
        name: NAMED_WORKSPACE,
      });
    }
  });

  await api.run("fin.debug.bundle", EXTENSION, async () => {
    const bundle = text(await api.invoke("sf_fin", { action: "debug" }));
    api.requireTrue(bundle.length > 0, "Empty debug bundle.");
    api.requireTrue(
      !bundle.includes(PERSONAL_TOKEN) && !bundle.includes(AGENT_KEY),
      "Debug bundle leaked a credential.",
    );
    const on = text(await api.invoke("sf_fin", { action: "debug", verbose: "on", runs: 1 }));
    const off = text(await api.invoke("sf_fin", { action: "debug", verbose: "off" }));
    return { bundleLines: bundle.split("\n").length, on, off };
  });

  await api.run("fin.admin.pages", EXTENSION, async () => {
    const result = await api.invoke("sf_fin", { action: "admin", operation: "pages" });
    api.requireTrue(api.details(result).operation === "pages", JSON.stringify(result));
    return { ok: api.details(result).ok, text: text(result).split("\n").slice(0, 4) };
  });

  await api.run("fin.command.help-connect", EXTENSION, async () => {
    const help = await commandOutput(api, "help");
    api.requireTrue(help.includes("/sf-fin"), `Unexpected help: ${help}`);
    const connect = await commandOutput(api, "connect");
    api.requireTrue(connect.includes("/login sf-fin"), `Unexpected connect: ${connect}`);
    const completions = api.command("sf-fin")?.getArgumentCompletions?.("sta");
    api.requireTrue(JSON.stringify(completions).includes("status"), "Missing status completion.");
    return { connect, completions };
  });

  await api.run("fin.logout", EXTENSION, async () => {
    await authStorage.credentials.remove("sf-fin");
    await authStorage.credentials.remove("sf-fin-agent");
    const status = text(await api.invoke("sf_fin", { action: "status" }));
    api.requireTrue(status.includes("Credential: not connected"), status);
    return status.split("\n")[2];
  });
}
