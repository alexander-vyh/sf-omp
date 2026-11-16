/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sf-docs offline behavior in native OMP. `/login sf-docs` runs through OMP's
 * real OAuth login pipeline into its hermetic credential store with a
 * synthetic endpoint and token; the one docs request is captured at the fetch
 * boundary and rejected, so nothing leaves the process.
 */
import type { SmokeApi } from "../omp-smoke-extension.ts";

const EXTENSION = "sf-docs";
const PROVIDER = "sf-docs";
const FIXTURE_ENDPOINT = "https://docs.example.test/mcp";
const FIXTURE_TOKEN = "omp-smoke-docs-fixture-token";

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
  modelRegistry: {
    authStorage: SmokeAuthStorage;
    getApiKeyForProvider(provider: string): Promise<string | undefined>;
  };
}

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

/** Run a command handler and return what it printed (print mode has no UI). */
async function commandOutput(
  api: SmokeApi,
  name: string,
  args: string,
): Promise<{ output: string; result: unknown }> {
  const command = api.command(name);
  api.requireTrue(command?.extension === EXTENSION, `Expected /${name} from ${EXTENSION}.`);
  const lines: string[] = [];
  const original = console.info;
  console.info = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try {
    const result = await command.handler(args, api.ctx);
    return { output: lines.join("\n"), result };
  } finally {
    console.info = original;
  }
}

export default async function sfDocsChecks(api: SmokeApi): Promise<void> {
  const ctx = api.ctx as SmokeContext;
  const authStorage = ctx.modelRegistry.authStorage;

  await api.run("docs.unconfigured.status", EXTENSION, async () => {
    api.requireTrue(
      !process.env.SF_DOCS_MCP_TOKEN && !process.env.SF_DOCS_MCP_ENDPOINT,
      "SF Docs automation env leaked into the smoke process.",
    );
    const result = await api.requireSuccess("sf_docs", { action: "status" });
    const status = text(result);
    api.requireTrue(
      status.includes("Configuration: not configured") &&
        status.includes("Token source: none") &&
        status.includes("Endpoint source: none"),
      `Expected unconfigured status: ${status}`,
    );
    const command = await commandOutput(api, "sf-docs", "status");
    api.requireTrue(
      command.output.includes("Configuration: not configured"),
      `/sf-docs status did not report unconfigured: ${command.output}`,
    );
    return { tool: status.split("\n").slice(0, 6), command: command.output.split("\n")[2] };
  });

  await api.run("docs.unconfigured.search", EXTENSION, async () => {
    const result = await api.invoke("sf_docs", { action: "search", query: "Apex triggers" });
    const details = api.details(result);
    api.requireTrue(
      details.ok === false && details.reason === "missing_auth",
      `Expected missing_auth: ${JSON.stringify(result)}`,
    );
    api.requireTrue(text(result).includes("/login sf-docs"), "Missing /login recovery hint.");
    return details;
  });

  await api.run("docs.login.native", EXTENSION, async () => {
    const prompts: LoginPrompt[] = [];
    const answers = [FIXTURE_ENDPOINT, FIXTURE_TOKEN];
    const identity = await authStorage.oauth.login(PROVIDER, {
      onAuth: () => undefined,
      onProgress: () => undefined,
      onPrompt: async (prompt) => {
        prompts.push(prompt);
        return answers.shift() ?? "";
      },
    });
    api.requireTrue(
      prompts.length === 2 &&
        prompts[0]?.secret !== true &&
        prompts[0]?.message.includes("endpoint") &&
        prompts[1]?.secret === true,
      `Expected endpoint text prompt then masked token prompt: ${JSON.stringify(prompts)}`,
    );
    const stored = authStorage.credentials.get(PROVIDER);
    const env = stored?.env as Record<string, unknown> | undefined;
    api.requireTrue(
      stored?.type === "oauth" &&
        stored.sfPiCredential === "api_key" &&
        stored.access === FIXTURE_TOKEN &&
        env?.SF_DOCS_MCP_ENDPOINT === FIXTURE_ENDPOINT,
      "OMP did not persist the SF Docs credential with its endpoint.",
    );
    api.requireTrue(
      (await ctx.modelRegistry.getApiKeyForProvider(PROVIDER)) === FIXTURE_TOKEN,
      "OMP did not resolve the saved SF Docs token.",
    );
    return {
      identity,
      prompts: prompts.map(({ message, secret }) => ({ message, secret: secret === true })),
      storedType: stored.type,
      storedKind: stored.sfPiCredential,
    };
  });

  await api.run("docs.configured.status", EXTENSION, async () => {
    const status = text(await api.requireSuccess("sf_docs", { action: "status" }));
    api.requireTrue(
      status.includes("Configuration: ready") &&
        status.includes("Token source: pi-auth") &&
        status.includes("Endpoint source: pi-auth"),
      `Expected configured status from the OMP store: ${status}`,
    );
    const command = await commandOutput(api, "sf-docs", "status");
    api.requireTrue(
      command.output.includes("Configuration: ready") &&
        command.output.includes("Token source: pi-auth"),
      `/sf-docs status did not report the saved credential: ${command.output}`,
    );
    api.requireTrue(!status.includes(FIXTURE_TOKEN), "Status leaked the token.");
    return { tool: status.split("\n").slice(2, 5), command: command.output.split("\n")[2] };
  });

  await api.run("docs.validation", EXTENSION, async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: "search" }, "missing_query"],
      [{ action: "ground" }, "missing_query"],
      [{ action: "fetch" }, "missing_ids_or_urls"],
      [{ action: "search", query: "Apex", version: "260" }, "invalid_docs_version"],
    ];
    const reasons: string[] = [];
    for (const [params, reason] of cases) {
      const details = api.details(await api.invoke("sf_docs", params));
      api.requireTrue(
        details.ok === false && details.reason === reason,
        `Expected ${reason} for ${JSON.stringify(params)}: ${JSON.stringify(details)}`,
      );
      reasons.push(String(details.reason));
    }
    return reasons;
  });

  await api.run("docs.search.request", EXTENSION, async () => {
    const captured: Array<{ url: string; authorization?: string; body: unknown }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      captured.push({
        url,
        authorization: headers.get("authorization") ?? undefined,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      throw new Error("Outbound fetch disabled by the offline OMP smoke check.");
    }, original);
    // Transport failures are thrown by the tool; OMP turns them into an error result.
    let failure = "";
    try {
      await api.invoke("sf_docs", { action: "search", query: "Apex trigger context variables" });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      globalThis.fetch = original;
    }
    const first = captured[0];
    const body = first?.body as
      | { jsonrpc?: string; method?: string; params?: { name?: string; arguments?: unknown } }
      | undefined;
    api.requireTrue(
      first?.url === FIXTURE_ENDPOINT &&
        first.authorization === `Bearer ${FIXTURE_TOKEN}` &&
        body?.jsonrpc === "2.0" &&
        body.method === "tools/call" &&
        body.params?.name === "search" &&
        JSON.stringify(body.params.arguments).includes("Apex trigger context variables"),
      `Unexpected docs request: ${JSON.stringify(captured.map(({ url, body: b }) => ({ url, b })))}`,
    );
    api.requireTrue(
      failure.includes("Outbound fetch disabled") && !failure.includes(FIXTURE_TOKEN),
      `Expected the rejected transport to fail the call without leaking the token: ${failure}`,
    );
    return {
      requests: captured.length,
      method: body.method,
      tool: body.params?.name,
      arguments: body.params?.arguments,
      failure,
    };
  });

  await api.run("docs.cheatsheet.help", EXTENSION, async () => {
    const cheatsheet = text(await api.requireSuccess("sf_docs", { action: "cheatsheet" }));
    api.requireTrue(cheatsheet.length > 200, "Cheatsheet is empty.");
    const help = await commandOutput(api, "sf-docs", "help");
    api.requireTrue(help.output.includes("/sf-docs"), `Unexpected help: ${help.output}`);
    const completions = api.command("sf-docs")?.getArgumentCompletions?.("st");
    api.requireTrue(
      JSON.stringify(completions).includes("status"),
      `Missing status completion: ${JSON.stringify(completions)}`,
    );
    return { cheatsheetChars: cheatsheet.length, completions };
  });

  await api.run("docs.connect.disconnect.print-mode", EXTENSION, async () => {
    const connect = await commandOutput(api, "sf-docs", "connect");
    api.requireTrue(
      connect.output.includes("/login sf-docs"),
      `Unexpected connect output: ${connect.output}`,
    );
    const disconnect = await commandOutput(api, "sf-docs", "disconnect");
    api.requireTrue(
      disconnect.output.includes("/logout sf-docs"),
      `Unexpected disconnect output: ${disconnect.output}`,
    );
    return { connect: connect.output, disconnect: disconnect.output };
  });

  await api.run("docs.logout", EXTENSION, async () => {
    await authStorage.credentials.remove(PROVIDER);
    const status = text(await api.requireSuccess("sf_docs", { action: "status" }));
    api.requireTrue(
      status.includes("Configuration: not configured"),
      `Expected unconfigured after logout: ${status}`,
    );
    return status.split("\n")[2];
  });
}
