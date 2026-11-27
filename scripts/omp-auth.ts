/* SPDX-License-Identifier: Apache-2.0 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { localBunExecutable, ROOT } from "./omp-runtime.ts";

type BrokerEnvironment = {
  OMP_AUTH_BROKER_URL: string;
  OMP_AUTH_BROKER_TOKEN: string;
};

export interface GlobalAuthConnection {
  environment: BrokerEnvironment;
  args: string[];
  close(): Promise<void>;
}

/** Resolve native global auth without importing Bun-only modules into Node. */
export async function connectGlobalAuth(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<GlobalAuthConnection> {
  const bun = localBunExecutable();
  const runtime = path.join(ROOT, ".runtime");
  const cache = path.join(runtime, "cache");
  const helper = spawn(bun, [path.join(ROOT, "scripts", "omp-auth-broker.ts")], {
    cwd: process.cwd(),
    // Preserve the original global auth roots/profiles, not runtimeEnvironment().
    env: {
      ...environment,
      PI_NATIVES_DIR: path.join(runtime, "omp", "natives"),
      BUN_INSTALL_CACHE_DIR: path.join(cache, "bun"),
      npm_config_cache: path.join(cache, "npm"),
    },
    // fd 3 is private protocol output; stdin EOF is the parent-death lease.
    stdio: ["pipe", "ignore", "ignore", "pipe"],
    // Terminal Ctrl-C belongs to the model turn, never to the auth service.
    detached: true,
  });
  const channel = helper.stdio[3];
  let overlayDirectory: string | undefined;
  const killOnExit = () => {
    helper.kill("SIGTERM");
    if (overlayDirectory) rmSync(overlayDirectory, { recursive: true, force: true });
  };
  process.once("exit", killOnExit);
  helper.stdin?.on("error", () => {});
  let exited = false;
  const stopped = Promise.withResolvers<void>();
  helper.once("close", () => {
    exited = true;
    stopped.resolve();
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      try {
        if (!exited) {
          helper.stdin?.end();
          helper.kill("SIGTERM");
          const force = setTimeout(() => helper.kill("SIGKILL"), 2_000);
          try {
            await stopped.promise;
          } finally {
            clearTimeout(force);
          }
        }
      } finally {
        if (overlayDirectory) await rm(overlayDirectory, { recursive: true, force: true });
        process.removeListener("exit", killOnExit);
      }
    })();
    return closing;
  };

  const ready = Promise.withResolvers<{
    environment: BrokerEnvironment;
    accountPolicies: unknown[];
    defaultReservePct: number;
  }>();
  let buffer = "";
  const timer = setTimeout(() => {
    ready.reject(new Error("Timed out connecting to global OMP authentication."));
  }, 60_000);
  const onError = () => {
    ready.reject(new Error("Could not start the repository-local global OMP auth helper."));
  };
  const onClose = () => {
    ready.reject(new Error("Global OMP auth helper exited before connecting."));
  };
  const onData = (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    try {
      const message: unknown = JSON.parse(buffer.slice(0, newline));
      buffer = "";
      if (typeof message !== "object" || message === null)
        throw new Error("Invalid response from global OMP auth helper.");
      if ("error" in message && typeof message.error === "string") throw new Error(message.error);
      if (
        !("OMP_AUTH_BROKER_URL" in message) ||
        typeof message.OMP_AUTH_BROKER_URL !== "string" ||
        !("OMP_AUTH_BROKER_TOKEN" in message) ||
        typeof message.OMP_AUTH_BROKER_TOKEN !== "string" ||
        !message.OMP_AUTH_BROKER_URL ||
        !message.OMP_AUTH_BROKER_TOKEN ||
        !("accountPolicies" in message) ||
        !Array.isArray(message.accountPolicies) ||
        !("defaultReservePct" in message) ||
        typeof message.defaultReservePct !== "number"
      )
        throw new Error("Invalid response from global OMP auth helper.");
      ready.resolve({
        environment: {
          OMP_AUTH_BROKER_URL: message.OMP_AUTH_BROKER_URL,
          OMP_AUTH_BROKER_TOKEN: message.OMP_AUTH_BROKER_TOKEN,
        },
        accountPolicies: message.accountPolicies,
        defaultReservePct: message.defaultReservePct,
      });
    } catch (error) {
      // JSON parse errors can contain the private response; never echo them.
      ready.reject(
        new Error(
          error instanceof SyntaxError
            ? "Invalid response from global OMP auth helper."
            : error instanceof Error
              ? error.message
              : "Could not connect to global OMP authentication.",
        ),
      );
    }
  };
  helper.once("error", onError);
  helper.once("close", onClose);
  if (channel instanceof Readable) {
    channel.setEncoding("utf8");
    channel.on("data", onData);
  } else {
    ready.reject(new Error("Could not open the private global OMP auth channel."));
  }

  try {
    const resolved = await ready.promise;
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    overlayDirectory = await mkdtemp(path.join(runtime, "auth-"));
    await chmod(overlayDirectory, 0o700);
    const overlay = path.join(overlayDirectory, "policy.yml");
    // JSON is valid YAML. This is an auth-policy-only overlay, never a copied
    // global config, credential database, broker bearer, or refresh token.
    await writeFile(
      overlay,
      JSON.stringify({
        auth: { accountPolicies: resolved.accountPolicies },
        retry: { usageReservePct: resolved.defaultReservePct },
      }),
      { mode: 0o600 },
    );
    return { environment: resolved.environment, args: ["--config", overlay], close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
    channel?.removeListener("data", onData);
    helper.removeListener("error", onError);
    helper.removeListener("close", onClose);
  }
}
