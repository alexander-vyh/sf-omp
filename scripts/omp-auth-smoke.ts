#!/usr/bin/env bun
/* SPDX-License-Identifier: Apache-2.0 */
/** Offline shared-auth integration: disposable native stores and the real local OMP host. */
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Subprocess } from "bun";
import { ROOT, localOmpCommand, runtimeEnvironment } from "./omp-runtime.ts";
import { connectGlobalAuth, type GlobalAuthConnection } from "./omp-auth.ts";
import {
  accountPolicy,
  fixtureEmail,
  initialAccess,
  initialApiKey,
  providers,
  refreshMaterial,
  reservePct,
  updatedAccess,
  updatedApiKey,
} from "./fixtures/omp-auth/credentials.ts";

function requireTrue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Deliberate allowlist: no real-user broker, auth, profiles, overlays or org inputs survive. */
function fixtureEnvironment(stateRoot: string): NodeJS.ProcessEnv {
  const source = runtimeEnvironment(stateRoot);
  const names = [
    "PATH",
    "LANG",
    "LC_ALL",
    "TERM",
    "HOME",
    "USERPROFILE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "PI_CODING_AGENT_DIR",
    "PI_CONFIG_DIR",
    "PI_NATIVES_DIR",
    "BUN_INSTALL_CACHE_DIR",
    "npm_config_cache",
  ];
  const result: NodeJS.ProcessEnv = {};
  for (const name of names) if (source[name] !== undefined) result[name] = source[name];
  result.CI = "true";
  result.SF_DISABLE_TELEMETRY = "true";
  result.SFDX_DISABLE_TELEMETRY = "true";
  return result;
}
function replaceEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(process.env)) delete process.env[name];
  for (const [name, value] of Object.entries(environment))
    if (value !== undefined) process.env[name] = value;
}

/** Fixture configuration/install bytes only; SQLite and its journal are active auth state. */
async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const filename = path.join(current, entry.name);
      const relative = path.relative(directory, filename);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isSymbolicLink()) result[relative] = `link:${await readlink(filename)}`;
      else if (!/\.db(?:[.-].*)?$|\.log(?:\..*)?$/.test(entry.name)) {
        result[relative] = createHash("sha256")
          .update(await readFile(filename))
          .digest("hex");
      }
    }
  }
  await visit(directory);
  return result;
}

const runtimeRoot = path.join(ROOT, ".runtime");
await mkdir(path.join(runtimeRoot, "auth-smoke"), { recursive: true, mode: 0o700 });
const inheritedRunRoot = process.env.SF_OMP_AUTH_SMOKE_RUN_ROOT;
requireTrue(
  !inheritedRunRoot || path.dirname(inheritedRunRoot) === path.join(runtimeRoot, "auth-smoke"),
  "Auth smoke child must remain inside the disposable fixture directory.",
);
const runRoot = inheritedRunRoot ?? (await mkdtemp(path.join(runtimeRoot, "auth-smoke", "run-")));
const reportPath = path.join(runtimeRoot, "omp-auth-smoke-report.json");
const fixtureRoot = path.join(runRoot, "global");
const clientRoot = path.join(runRoot, "client");
const hostRoot = path.join(runRoot, "host");
const globalEnvironment = fixtureEnvironment(fixtureRoot);
// Bun caches os.homedir() at process startup. Start the native fixture with its
// isolated HOME already installed, rather than changing only process.env later.
if (!inheritedRunRoot) {
  const [bun] = localOmpCommand();
  const fixture = Bun.spawn([bun, import.meta.filename], {
    cwd: ROOT,
    env: { ...globalEnvironment, SF_OMP_AUTH_SMOKE_RUN_ROOT: runRoot },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const stop = () => fixture.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let code: number;
  try {
    code = await fixture.exited;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await rm(runRoot, { recursive: true, force: true });
  }
  process.exit(code);
}

// Native imports must never see real-user global auth/config roots.
replaceEnvironment(globalEnvironment);

const checks: Record<string, boolean> = {
  passed: false,
  nativeGlobalStore: false,
  brokerDiscovered: false,
  existingBrokerReused: false,
  refreshMaterialHidden: false,
  nativeClientApiKey: false,
  nativeClientOAuth: false,
  liveApiKeyChangeObserved: false,
  liveOAuthChangeObserved: false,
  nativeHost: false,
  tenSalesforceRegistrations: false,
  localDatabaseAndSessions: false,
  accountPoliciesInherited: false,
  unrelatedGlobalSettingsExcluded: false,
  globalExtensionNotLoaded: false,
  fixtureConfigAndExtensionsUnchanged: false,
  noGlobalBrokerTokenFile: false,
  managedBrokerStopped: false,
};
let connection: GlobalAuthConnection | undefined;
let reused: GlobalAuthConnection | undefined;
let child: Subprocess<"pipe", "pipe", "pipe"> | undefined;
let globalStore: { close(): void } | undefined;
let clientAuth: { close(): void } | undefined;
let interrupted = false;
let failed = false;
const onSignal = () => {
  interrupted = true;
  child?.kill("SIGKILL");
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

try {
  // Test the native module-loading boundary: static imports freeze real-user directories before fixture HOME is installed.
  const { SqliteAuthCredentialStore, AuthStorage, REMOTE_REFRESH_SENTINEL } =
    await import("@oh-my-pi/pi-ai");
  const { AuthBrokerClient, RemoteAuthCredentialStore } =
    await import("@oh-my-pi/pi-ai/auth-broker");
  const { resolveAuthBrokerConfig, openAuthCredentialStore } =
    await import("@oh-my-pi/pi-ai/auth-broker/discover");
  const { getAgentDbPath, getAgentDir, getConfigRootDir, setAgentDir } =
    await import("@oh-my-pi/pi-utils");
  const globalDb = getAgentDbPath();
  const globalAgent = getAgentDir();
  const globalConfigRoot = getConfigRootDir();
  requireTrue(
    globalDb.startsWith(`${fixtureRoot}${path.sep}`),
    "Fixture global database escaped the disposable root.",
  );
  const store = await SqliteAuthCredentialStore.open(globalDb);
  globalStore = store;
  await store.saveApiKey("openai", initialApiKey);
  const oauth = {
    access: initialAccess,
    refresh: refreshMaterial,
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    email: fixtureEmail,
  };
  await store.saveOAuth("anthropic", oauth);
  checks.nativeGlobalStore = store.listAuthCredentials().length === 2;
  requireTrue(checks.nativeGlobalStore, "Fixture native store did not retain both providers.");

  const sentinelMarker = path.join(runRoot, "global-extension-loaded");
  const sentinelPath = path.join(globalAgent, "extensions", "global-sentinel.ts");
  await mkdir(path.dirname(sentinelPath), { recursive: true, mode: 0o700 });
  await cp(path.join(ROOT, "scripts", "fixtures", "omp-auth", "global-sentinel.ts"), sentinelPath);
  await writeFile(
    path.join(globalAgent, "config.yml"),
    [
      "compaction:",
      "  enabled: false",
      "retry:",
      `  usageReservePct: ${reservePct}`,
      "auth:",
      "  accountPolicies:",
      "    - provider: anthropic",
      "      account:",
      `        email: ${fixtureEmail}`,
      `      priority: ${accountPolicy.priority}`,
      `      reservePct: ${accountPolicy.reservePct}`,
      "extensions:",
      `  - ${JSON.stringify(sentinelPath)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const before = await snapshot(globalConfigRoot);
  connection = await connectGlobalAuth(globalEnvironment);
  requireTrue(!interrupted, "Auth smoke was interrupted.");
  const brokerConfig = {
    url: connection.environment.OMP_AUTH_BROKER_URL,
    token: connection.environment.OMP_AUTH_BROKER_TOKEN,
  };
  requireTrue(
    new URL(brokerConfig.url).hostname === "127.0.0.1",
    "Fixture broker is not loopback-only.",
  );
  const brokerClient = new AuthBrokerClient({ ...brokerConfig, maxRetries: 0 });
  reused = await connectGlobalAuth({ ...globalEnvironment, ...connection.environment });
  checks.existingBrokerReused =
    reused.environment.OMP_AUTH_BROKER_URL === brokerConfig.url &&
    reused.environment.OMP_AUTH_BROKER_TOKEN === brokerConfig.token;
  requireTrue(checks.existingBrokerReused, "Configured native broker was not reused.");
  await reused.close();
  reused = undefined;
  await brokerClient.healthz();

  const localEnvironment = { ...fixtureEnvironment(clientRoot), ...connection.environment };
  replaceEnvironment(localEnvironment);
  requireTrue(localEnvironment.PI_CODING_AGENT_DIR, "Fixture client agent root is missing.");
  setAgentDir(localEnvironment.PI_CODING_AGENT_DIR);
  const discoveredConfig = await resolveAuthBrokerConfig();
  checks.brokerDiscovered =
    discoveredConfig?.url === brokerConfig.url && discoveredConfig.token === brokerConfig.token;
  requireTrue(
    checks.brokerDiscovered && discoveredConfig,
    "Native auth discovery did not select the broker.",
  );
  const opened = await openAuthCredentialStore({
    brokerConfig: discoveredConfig,
    agentDir: getAgentDir(),
    cachePath: path.join(clientRoot, "broker-snapshot.cache"),
  });
  requireTrue(
    opened.store instanceof RemoteAuthCredentialStore,
    "Native auth discovery opened a local credential store instead of the broker.",
  );
  const remote = opened.store;
  const auth = new AuthStorage(remote);
  clientAuth = auth;
  await auth.credentials.reload();
  const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
  const registry = new ModelRegistry(auth, path.join(getAgentDir(), "models.yml"));
  checks.nativeClientApiKey = (await registry.getApiKeyForProvider("openai")) === initialApiKey;
  checks.nativeClientOAuth = (await registry.getApiKeyForProvider("anthropic")) === initialAccess;
  requireTrue(
    checks.nativeClientApiKey && checks.nativeClientOAuth,
    "Native ModelRegistry did not resolve the initial fixture credentials.",
  );
  const initialSnapshot = await brokerClient.fetchSnapshot();
  requireTrue(initialSnapshot.status === 200, "Native broker did not return a snapshot.");
  const oauthEntry = initialSnapshot.snapshot.credentials.find(
    (entry) => entry.provider === "anthropic",
  );
  checks.refreshMaterialHidden =
    oauthEntry?.credential.type === "oauth" &&
    oauthEntry.credential.refresh === REMOTE_REFRESH_SENTINEL &&
    !JSON.stringify(initialSnapshot.snapshot).includes(refreshMaterial);
  requireTrue(checks.refreshMaterialHidden, "Native broker exposed fixture refresh material.");

  // The broker remains running, and this same native client must see real global-store writes.
  await store.saveApiKey("openai", updatedApiKey);
  await store.saveOAuth("anthropic", { ...oauth, access: updatedAccess });
  const changeDeadline = Date.now() + 15_000;
  while (Date.now() < changeDeadline) {
    await remote.refreshSnapshot();
    await auth.credentials.reload();
    checks.liveApiKeyChangeObserved =
      (await registry.getApiKeyForProvider("openai")) === updatedApiKey;
    checks.liveOAuthChangeObserved =
      (await registry.getApiKeyForProvider("anthropic")) === updatedAccess;
    if (checks.liveApiKeyChangeObserved && checks.liveOAuthChangeObserved) break;
    await Bun.sleep(100);
  }
  requireTrue(
    checks.liveApiKeyChangeObserved && checks.liveOAuthChangeObserved,
    "Native broker client retained stale fixture credentials.",
  );
  auth.close();
  clientAuth = undefined;

  const workspace = path.join(runRoot, "workspace");
  await cp(path.join(ROOT, "scripts", "fixtures", "omp-smoke"), workspace, { recursive: true });
  const hostReportPath = path.join(runRoot, "host-report.json");
  const hostEnvironment = {
    ...fixtureEnvironment(hostRoot),
    ...connection.environment,
    SF_OMP_AUTH_HOST_REPORT: hostReportPath,
    SF_OMP_AUTH_HOST_STATE: hostRoot,
    SF_OMP_AUTH_GLOBAL_DB: globalDb,
    SF_OMP_AUTH_SENTINEL_MARKER: sentinelMarker,
    SF_OMP_AUTH_PARENT_PID: String(process.pid),
  };
  const command = [
    ...localOmpCommand(),
    ...connection.args,
    "--mode",
    "rpc",
    "--no-ui",
    "--no-title",
    "--no-extensions",
    "-e",
    ROOT,
    "--no-skills",
    "--no-rules",
    "--no-context-files",
    "-e",
    path.join(ROOT, "scripts", "fixtures", "omp-auth", "host-extension.ts"),
    "--provider",
    "openai",
    "--model",
    "gpt-4o-mini",
  ];
  child = Bun.spawn(command, {
    cwd: workspace,
    env: hostEnvironment,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${JSON.stringify({ id: "auth-smoke-state-only", type: "get_state" })}\n`);
  child.stdin.end();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child?.kill("SIGKILL");
  }, 120_000);
  let exitCode: number;
  try {
    const result = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    exitCode = result[0];
    // Child output may include auth diagnostics; never persist or print it.
  } finally {
    clearTimeout(timeout);
  }
  child = undefined;
  const host = record(JSON.parse(await readFile(hostReportPath, "utf8")));
  checks.nativeHost =
    !timedOut &&
    !interrupted &&
    exitCode === 0 &&
    host.passed === true &&
    host.sessionStarted === true &&
    host.sessionShutdown === true &&
    host.apiKeyResolved === true &&
    host.oauthResolved === true &&
    host.noExternalRequests === true;
  checks.tenSalesforceRegistrations = host.tenSalesforceRegistrations === true;
  checks.localDatabaseAndSessions =
    host.localDatabase === true &&
    host.localConfig === true &&
    host.localSessions === true &&
    host.clientHasNoCredentialRows === true;
  checks.accountPoliciesInherited = host.accountPoliciesInherited === true;
  checks.unrelatedGlobalSettingsExcluded = host.unrelatedGlobalSettingsExcluded === true;
  checks.globalExtensionNotLoaded = !(await Bun.file(sentinelMarker).exists());
  checks.fixtureConfigAndExtensionsUnchanged =
    JSON.stringify(before) === JSON.stringify(await snapshot(globalConfigRoot));
  checks.noGlobalBrokerTokenFile = !(await Bun.file(
    path.join(globalConfigRoot, "auth-broker.token"),
  ).exists());
  requireTrue(
    checks.nativeHost &&
      checks.tenSalesforceRegistrations &&
      checks.localDatabaseAndSessions &&
      checks.accountPoliciesInherited &&
      checks.unrelatedGlobalSettingsExcluded &&
      checks.globalExtensionNotLoaded &&
      checks.fixtureConfigAndExtensionsUnchanged &&
      checks.noGlobalBrokerTokenFile,
    "Native auth host integration or extension/state isolation failed.",
  );
  await connection.close();
  connection = undefined;
  try {
    await fetch(new URL("/v1/healthz", brokerConfig.url), { signal: AbortSignal.timeout(1500) });
  } catch {
    checks.managedBrokerStopped = true;
  }
  requireTrue(checks.managedBrokerStopped, "Managed fixture broker remained alive after close.");
  checks.passed = true;
} catch {
  failed = true;
  // Never print arbitrary native errors, HTTP bodies or credential-bearing process output.
} finally {
  const cleanup = await Promise.allSettled([
    (async () => {
      if (child) {
        child.kill("SIGKILL");
        await child.exited;
      }
    })(),
    (async () => {
      clientAuth?.close();
    })(),
    (async () => {
      await reused?.close();
    })(),
    (async () => {
      await connection?.close();
    })(),
    (async () => {
      globalStore?.close();
    })(),
  ]);
  if (cleanup.some((result) => result.status === "rejected")) {
    failed = true;
    checks.passed = false;
  }
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  await rm(runRoot, { recursive: true, force: true });
  await writeFile(reportPath, `${JSON.stringify({ ...checks, providers }, null, 2)}\n`, {
    mode: 0o600,
  });
}
console.log(`OMP shared auth smoke: ${checks.passed && !failed ? "PASS" : "FAIL"}`);
if (!checks.passed || failed) {
  console.error(
    `Failed checks: ${Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
      .join(", ")}`,
  );
  process.exitCode = 1;
}
