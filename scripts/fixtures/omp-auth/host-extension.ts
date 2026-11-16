/* SPDX-License-Identifier: Apache-2.0 */
/** Observes the genuine native host; does not register or reload Salesforce factories. */
import { readFileSync } from "node:fs";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { SqliteAuthCredentialStore, REMOTE_REFRESH_SENTINEL } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import { getAgentDbPath, getAgentDir, getConfigRootDir } from "@oh-my-pi/pi-utils";
import {
  loadEffectiveAuthAccountPolicyConfig,
  resolveEffectiveSettings,
} from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import {
  accountPolicy,
  refreshMaterial,
  reservePct,
  updatedAccess,
  updatedApiKey,
} from "./credentials.ts";

const root = path.resolve(import.meta.dirname, "../../..");
// Every packaged extension that declares slash commands must register them natively.
const expectedCommands = (
  JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    pi: { extensions: string[] };
  }
).pi.extensions.flatMap((entry) => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, path.dirname(entry), "manifest.json"), "utf8"),
  ) as { commands?: string[] };
  return (manifest.commands ?? []).map((command) => command.replace(/^\//, ""));
});

function requireTrue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export default function authHostObserver(pi: ExtensionAPI): void {
  const reportPath = process.env.SF_OMP_AUTH_HOST_REPORT;
  const stateRoot = process.env.SF_OMP_AUTH_HOST_STATE;
  const globalDb = process.env.SF_OMP_AUTH_GLOBAL_DB;
  const brokerUrl = process.env.OMP_AUTH_BROKER_URL;
  const brokerToken = process.env.OMP_AUTH_BROKER_TOKEN;
  requireTrue(
    reportPath && stateRoot && globalDb && brokerUrl && brokerToken,
    "Missing auth smoke fixture configuration.",
  );
  const brokerOrigin = new URL(brokerUrl).origin;
  requireTrue(new URL(brokerUrl).hostname === "127.0.0.1", "Fixture broker must be loopback-only.");
  const report: Record<string, boolean> = {
    passed: false,
    sessionStarted: false,
    sessionShutdown: false,
    apiKeyResolved: false,
    oauthResolved: false,
    refreshMaterialHidden: false,
    salesforceRegistrations: false,
    localDatabase: false,
    localSessions: false,
    localConfig: false,
    clientHasNoCredentialRows: false,
    accountPoliciesInherited: false,
    unrelatedGlobalSettingsExcluded: false,
    noExternalRequests: true,
  };
  const persist = () =>
    writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const input = args[0];
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (url.origin !== brokerOrigin) {
        report.noExternalRequests = false;
        throw new Error("External network disabled by auth smoke.");
      }
    }
    return originalFetch(...args);
  }, originalFetch);
  // A hard-killed harness must not leave a native host behind.
  const parentPid = Number(process.env.SF_OMP_AUTH_PARENT_PID);
  const parentWatch = setInterval(() => {
    if (process.ppid !== parentPid) process.exit(1);
  }, 500);
  parentWatch.unref();

  pi.on("session_start", async (_event, ctx) => {
    report.sessionStarted = true;
    try {
      const model = ctx.modelRegistry.find("openai", "gpt-4o-mini");
      requireTrue(model, "Fixture OpenAI model is missing.");
      report.apiKeyResolved = (await ctx.modelRegistry.getApiKey(model)) === updatedApiKey;
      report.oauthResolved =
        (await ctx.modelRegistry.getApiKeyForProvider("anthropic")) === updatedAccess;
      requireTrue(
        report.apiKeyResolved && report.oauthResolved,
        "Native host did not resolve broker fixture credentials.",
      );
      const client = new AuthBrokerClient({ url: brokerUrl, token: brokerToken, maxRetries: 0 });
      const result = await client.fetchSnapshot();
      requireTrue(result.status === 200, "Fixture broker snapshot is unavailable.");
      const oauth = result.snapshot.credentials.find((entry) => entry.provider === "anthropic");
      report.refreshMaterialHidden =
        oauth?.credential.type === "oauth" &&
        oauth.credential.refresh === REMOTE_REFRESH_SENTINEL &&
        !JSON.stringify(result.snapshot).includes(refreshMaterial);
      requireTrue(report.refreshMaterialHidden, "Broker leaked fixture OAuth refresh material.");

      const commands = new Set(
        pi
          .getCommands()
          .filter((command) => command.source === "extension")
          .map((command) => command.name),
      );
      report.salesforceRegistrations =
        expectedCommands.length > 0 && expectedCommands.every((name) => commands.has(name));
      requireTrue(
        report.salesforceRegistrations,
        `Native host is missing Salesforce commands: ${expectedCommands.filter((name) => !commands.has(name)).join(", ")}`,
      );

      const expectedRoot = await realpath(stateRoot);
      const localDb = getAgentDbPath();
      const localStat = await lstat(localDb);
      const globalStat = await lstat(globalDb);
      report.localDatabase =
        localStat.isFile() &&
        !localStat.isSymbolicLink() &&
        within(expectedRoot, await realpath(localDb)) &&
        (localStat.dev !== globalStat.dev || localStat.ino !== globalStat.ino) &&
        (await realpath(localDb)) !== (await realpath(globalDb));
      report.localConfig =
        within(expectedRoot, await realpath(getAgentDir())) &&
        within(expectedRoot, await realpath(getConfigRootDir()));
      const localStore = await SqliteAuthCredentialStore.open(localDb);
      try {
        report.clientHasNoCredentialRows =
          localStore.listAuthCredentials().length === 0 &&
          !(await readFile(localDb)).includes(Buffer.from(refreshMaterial));
      } finally {
        localStore.close();
      }
      await ctx.sessionManager.ensureOnDisk();
      const sessionFile = ctx.sessionManager.getSessionFile();
      requireTrue(sessionFile, "Native host did not persist a local session.");
      report.localSessions =
        within(expectedRoot, await realpath(sessionFile)) &&
        within(expectedRoot, await realpath(ctx.sessionManager.getSessionDir()));
      requireTrue(
        report.localDatabase &&
          report.localConfig &&
          report.localSessions &&
          report.clientHasNoCredentialRows,
        "Native host state escaped its isolated local root.",
      );

      const settings = await resolveEffectiveSettings({ cwd: ctx.cwd });
      const policy = await loadEffectiveAuthAccountPolicyConfig({ settings });
      const inherited = policy.accountPolicies[0];
      report.accountPoliciesInherited =
        policy.defaultReservePct === reservePct &&
        policy.accountPolicies.length === 1 &&
        inherited?.provider === accountPolicy.provider &&
        inherited.account.email === accountPolicy.account.email &&
        inherited.priority === accountPolicy.priority &&
        inherited.reservePct === accountPolicy.reservePct;
      report.unrelatedGlobalSettingsExcluded = cfgCompactionEnabled.get(settings) === true;
      requireTrue(report.accountPoliciesInherited, "Native host lost global auth routing policy.");
      requireTrue(
        report.unrelatedGlobalSettingsExcluded,
        "Native host imported unrelated global settings.",
      );
      report.passed = report.noExternalRequests;
    } finally {
      await persist();
    }
  });
  pi.on("session_shutdown", async () => {
    clearInterval(parentWatch);
    report.sessionShutdown = true;
    report.passed = report.passed && report.noExternalRequests;
    await persist();
    globalThis.fetch = originalFetch;
  });
}
