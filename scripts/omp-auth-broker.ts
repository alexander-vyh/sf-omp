/* SPDX-License-Identifier: Apache-2.0 */
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { writeSync } from "node:fs";
import { type AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
  AuthBrokerClient,
  type AuthBrokerServerHandle,
  startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { createBrokerAuthStorage } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import {
  loadEffectiveAuthAccountPolicyConfig,
  resolveAuthBrokerConfig,
} from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { getAgentDbPath, VERSION } from "@oh-my-pi/pi-utils";
import { setTransports } from "@oh-my-pi/pi-utils/logger";

setTransports({ console: false, file: false });

// Only the controller reads fd 3. No credentials go to stdout/stderr or disk.
function reply(message: object): void {
  writeSync(3, `${JSON.stringify(message)}\n`);
}

let storage: AuthStorage | undefined;
let store: SqliteAuthCredentialStore | undefined;
let broker: AuthBrokerServerHandle | undefined;
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await broker?.close();
  } finally {
    try {
      if (storage) storage.close();
      else store?.close();
    } finally {
      process.exit(0);
    }
  }
}

// EOF also covers SIGKILL/crashes of the launcher; no detached service survives.
process.stdin.on("end", () => void close());
process.stdin.on("error", () => void close());
process.stdin.resume();
process.once("SIGTERM", () => void close());
process.once("SIGHUP", () => void close());
process.on("SIGINT", () => {});

let failure = "Could not resolve global OMP auth. Check its broker configuration and token source.";
try {
  const configured = await resolveAuthBrokerConfig();
  failure = "Could not load global OMP auth account policies.";
  const policies = await loadEffectiveAuthAccountPolicyConfig();
  if (configured) {
    failure =
      "Could not authenticate with the configured global OMP auth broker; no local fallback was used.";
    // Health is unauthenticated; a snapshot proves the supplied bearer works.
    await new AuthBrokerClient({ ...configured, maxRetries: 0 }).fetchSnapshot();
    reply({
      OMP_AUTH_BROKER_URL: configured.url,
      OMP_AUTH_BROKER_TOKEN: configured.token,
      ...policies,
    });
  } else {
    failure =
      "Global OMP credentials are unavailable. Authenticate with global OMP before starting sf-omp.";
    const database = getAgentDbPath();
    // Do not silently create an empty global vault when auth roots are wrong.
    await access(database);
    store = await SqliteAuthCredentialStore.open(database);
    storage = createBrokerAuthStorage(store);
    await storage.credentials.reload();
    failure = "Could not apply global OMP auth account policies.";
    storage.setAccountPolicies(policies);
    failure = "Could not start the private loopback global OMP auth broker.";
    const token = randomBytes(32).toString("hex");
    broker = startAuthBroker({
      storage,
      bind: "127.0.0.1:0",
      bearerTokens: [token],
      trustProxyHeaders: false,
      version: VERSION,
    });
    reply({ OMP_AUTH_BROKER_URL: broker.url, OMP_AUTH_BROKER_TOKEN: token, ...policies });
  }
} catch {
  // Native/config errors may embed command output or secrets. Report the phase,
  // not the raw exception, and never fall back to isolated local credentials.
  try {
    reply({ error: failure });
  } finally {
    await close();
  }
}
