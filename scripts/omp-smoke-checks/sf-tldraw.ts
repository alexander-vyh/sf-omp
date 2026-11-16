/* SPDX-License-Identifier: Apache-2.0 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { tldrawOfficeToolchain } from "../omp-runtime.ts";
import { redactDisplayText } from "../../lib/common/redaction.ts";
import { getTldrawStatus } from "../../lib/common/tldraw-status/store.ts";
import { globalSettingsPath, projectSettingsPath } from "../../lib/common/sf-pi-settings.ts";
import {
  clearTldrawPreference,
  writeTldrawPreference,
} from "../../extensions/sf-tldraw/lib/settings.ts";
import {
  defaultTldrawServerConfigPath,
  hasTldrawServerConfig,
} from "../../extensions/sf-tldraw/lib/runtime-client.ts";
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-tldraw";
const TOOL = "tldraw_canvas";
const EXTENSION_DIR = path.resolve(import.meta.dirname, "..", "..", "extensions", ID);

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value !== null && typeof value === "object" ? (value as Json) : {};
}

function fixture(name: string): Json {
  return JSON.parse(
    readFileSync(path.join(EXTENSION_DIR, "tests", "fixtures", `${name}.json`), "utf8"),
  ) as Json;
}

export default async function check(api: SmokeApi): Promise<void> {
  const tldraw = (result: unknown): Json => record(api.details(result).sfTldraw);
  const text = (result: unknown): string =>
    String(record((record(result).content as unknown[] | undefined)?.[0]).text ?? "");
  const artifactsRoot = path.join(getAgentDir(), "sf-pi", "tldraw-artifacts");
  const artifactRuns = (): number =>
    existsSync(path.join(artifactsRoot, "runs"))
      ? readdirSync(path.join(artifactsRoot, "runs")).length
      : 0;

  // Every offline check must stop before the loopback Canvas API: count fetch attempts.
  let fetches = 0;
  async function offline<T>(serverConfig: string, action: () => Promise<T>): Promise<T> {
    const previousEnv = process.env.TLDRAW_SERVER_CONFIG;
    const previousFetch = globalThis.fetch;
    const before = fetches;
    process.env.TLDRAW_SERVER_CONFIG = serverConfig;
    globalThis.fetch = Object.assign((...args: Parameters<typeof fetch>) => {
      fetches++;
      return previousFetch(...args);
    }, previousFetch);
    try {
      const result = await action();
      api.requireTrue(fetches === before, "tldraw offline check attempted a Canvas API request.");
      return result;
    } finally {
      globalThis.fetch = previousFetch;
      if (previousEnv === undefined) delete process.env.TLDRAW_SERVER_CONFIG;
      else process.env.TLDRAW_SERVER_CONFIG = previousEnv;
    }
  }

  const missingConfig = api.file("tldraw/absent/server.json");
  const staleConfig = api.file("tldraw/stale/server.json");
  mkdirSync(path.dirname(staleConfig), { recursive: true });

  await api.run("tldraw.status.default-discovery", ID, async () => {
    const configPath = defaultTldrawServerConfigPath();
    api.requireTrue(
      !hasTldrawServerConfig(configPath),
      `tldraw server.json unexpectedly present at ${configPath}; status would probe loopback.`,
    );
    const result = await offline(configPath, () => api.requireSuccess(TOOL, { action: "status" }));
    const status = record(tldraw(result).status);
    api.requireTrue(status.kind === "not-running", `status kind: ${JSON.stringify(status)}`);
    api.requireTrue(
      record(status.skillReadiness).kind === "missing",
      `isolated OMP agent dir should have no tldraw-offline skill: ${JSON.stringify(status)}`,
    );
    api.requireTrue(
      text(result).includes("- Runtime: not-running") &&
        text(result).includes("tldraw offline is not running"),
      text(result),
    );
    const published = getTldrawStatus();
    api.requireTrue(
      published.kind === "not-running" && published.origin === "interaction",
      `status widget store: ${JSON.stringify(published)}`,
    );
    return { configPath, status, published: published.kind };
  });

  await api.run("tldraw.status.stale-config", ID, async () => {
    const observed: unknown[] = [];
    for (const content of ["{not json", JSON.stringify({ port: 49152 })]) {
      writeFileSync(staleConfig, content);
      const result = await offline(staleConfig, () =>
        api.requireSuccess(TOOL, { action: "status" }),
      );
      const status = record(tldraw(result).status);
      api.requireTrue(
        status.kind === "stale-config" && String(status.message).includes("invalid or stale"),
        `stale config status: ${JSON.stringify(status)}`,
      );
      observed.push(status.kind);
    }
    return { observed };
  });

  await api.run("tldraw.cheatsheet", ID, async () => {
    const result = await offline(missingConfig, () =>
      api.requireSuccess(TOOL, { action: "cheatsheet" }),
    );
    const expected = readFileSync(path.join(EXTENSION_DIR, "docs", "cheatsheet.md"), "utf8");
    api.requireTrue(text(result) === expected, "cheatsheet text differs from docs/cheatsheet.md");
    api.requireTrue(tldraw(result).lazy === true, JSON.stringify(api.details(result)));
    return { chars: expected.length };
  });

  await api.run("tldraw.documents.runtime-absent", ID, async () => {
    const result = await offline(missingConfig, () =>
      api.requireSuccess(TOOL, { action: "documents" }),
    );
    const details = tldraw(result);
    api.requireTrue(
      Array.isArray(details.documents) && details.documents.length === 0,
      JSON.stringify(details),
    );
    api.requireTrue(text(result).startsWith("No tldraw documents are open."), text(result));
    return details;
  });

  await api.run("tldraw.create_document.name-validation", ID, async () => {
    const missing = await offline(missingConfig, () =>
      api.invoke(TOOL, { action: "create_document" }),
    );
    api.requireTrue(tldraw(missing).reason === "missing_name", JSON.stringify(missing));
    const rejected: string[] = [];
    for (const name of ["../escape", "Board.tldr", "Board.png"]) {
      const result = await offline(missingConfig, () =>
        api.invoke(TOOL, { action: "create_document", name }),
      );
      const details = tldraw(result);
      api.requireTrue(
        details.ok === false &&
          details.reason === "invalid_request" &&
          record(details.recover_via).action === "create_document",
        `${name}: ${JSON.stringify(result)}`,
      );
      rejected.push(name);
    }
    return { rejected };
  });

  await api.run("tldraw.create_document.runtime-boundary", ID, async () => {
    const result = await offline(missingConfig, () =>
      api.invoke(TOOL, { action: "create_document", name: "Smoke Support Model" }),
    );
    const details = tldraw(result);
    api.requireTrue(
      details.ok === false &&
        details.reason === "not_running" &&
        record(details.recover_via).action === "status",
      JSON.stringify(result),
    );
    return details;
  });

  await api.run("tldraw.render.invalid-spec", ID, async () => {
    // Structural (schema) failures prove Spec v2 is enforced under OMP's remapped `typebox`.
    const cases: Array<[string, unknown, string, string]> = [];
    const unknownField = fixture("data-model");
    record((unknownField.objects as unknown[])[0]).apiName = "Account";
    cases.push([
      "render_salesforce_data_model",
      unknownField,
      "objects[0].apiName",
      "unknown_field",
    ]);
    const badEnum = fixture("data-model");
    record((badEnum.relationships as unknown[])[0]).type = "junction";
    cases.push([
      "render_salesforce_data_model",
      badEnum,
      "relationships[0].type",
      "invalid_relationship_type",
    ]);
    const badId = fixture("architecture");
    record((badId.systems as unknown[])[0]).id = "1 bad id";
    cases.push(["render_salesforce_architecture", badId, "systems[0].id", "invalid_id"]);
    const badGrounding = fixture("sequence");
    record(badGrounding.grounding).extra = true;
    cases.push(["render_salesforce_sequence", badGrounding, "grounding.extra", "unknown_field"]);
    cases.push(["render_salesforce_architecture", fixture("data-model"), "family", ""]);
    cases.push(["render_salesforce_sequence", { family: "sequence" }, "spec_version", ""]);
    const observed: unknown[] = [];
    for (const [action, spec, expectedPath, expectedCode] of cases) {
      const result = await offline(missingConfig, () => api.invoke(TOOL, { action, spec }));
      const details = tldraw(result);
      const errors = (record(details.validation).errors as Json[] | undefined) ?? [];
      api.requireTrue(
        details.ok === false &&
          details.reason === "invalid_spec" &&
          record(details.recover_via).action === "cheatsheet" &&
          errors.some(
            (error) =>
              error.path === expectedPath && (!expectedCode || error.code === expectedCode),
          ),
        `${action} expected ${expectedCode || "error"} at ${expectedPath}: ${JSON.stringify(details)}`,
      );
      observed.push({ action, paths: errors.map((error) => error.path).slice(0, 6) });
    }
    return { observed };
  });

  await api.run("tldraw.render.page-name-privacy", ID, async () => {
    const observed: unknown[] = [];
    for (const page_name of ["owner@example.test", "Basic YWJjZGVmZ2hpamts"]) {
      const result = await offline(missingConfig, () =>
        api.invoke(TOOL, {
          action: "render_salesforce_data_model",
          spec: fixture("data-model"),
          page_name,
        }),
      );
      const details = tldraw(result);
      const errors = (record(details.validation).errors as Json[] | undefined) ?? [];
      api.requireTrue(
        details.reason === "invalid_page_name" &&
          errors.some(
            (error) => error.code === "private_rendered_value" && error.path === "page_name",
          ) &&
          !text(result).includes(page_name),
        JSON.stringify(result),
      );
      observed.push(details.reason);
    }
    return { observed };
  });

  for (const [action, name] of [
    ["render_salesforce_data_model", "data-model"],
    ["render_salesforce_architecture", "architecture"],
    ["render_salesforce_sequence", "sequence"],
    ["render_salesforce_sequence", "oauth-sequence"],
  ] as const) {
    await api.run(`tldraw.render.${name}.runtime-boundary`, ID, async () => {
      const runsBefore = artifactRuns();
      const result = await offline(missingConfig, () =>
        api.invoke(TOOL, {
          action,
          spec: fixture(name),
          page_name: "Smoke Page",
          render_mode: "preserve",
          output_mode: "file_only",
        }),
      );
      const details = tldraw(result);
      api.requireTrue(
        details.ok === false &&
          details.reason === "not_running" &&
          details.validation === undefined &&
          record(details.recover_via).action === "status",
        `valid ${name} spec should stop at the runtime boundary: ${JSON.stringify(result)}`,
      );
      api.requireTrue(artifactRuns() === runsBefore, "render wrote artifacts without a runtime");
      api.requireTrue(getTldrawStatus().kind === "not-running", "status store not updated");
      return { reason: details.reason, message: text(result), artifactsRoot };
    });
  }

  await api.run("tldraw.settings.omp-paths", ID, async () => {
    const workspace = api.workspace;
    const globalPath = globalSettingsPath();
    const projectPath = projectSettingsPath(workspace);
    api.requireTrue(
      globalPath === path.join(getAgentDir(), "settings.json"),
      `global settings outside OMP agent dir: ${globalPath}`,
    );
    api.requireTrue(
      projectPath === path.join(workspace, ".pi", "settings.json"),
      `project settings path: ${projectPath}`,
    );
    try {
      writeTldrawPreference(workspace, "global", "ldvThreshold", "5M");
      const effective = writeTldrawPreference(workspace, "project", "cardFill", "family");
      api.requireTrue(
        effective.cardFill === "family" &&
          effective.ldvThreshold === "5M" &&
          effective.sources.cardFill.path === projectPath &&
          effective.sources.ldvThreshold.path === globalPath,
        JSON.stringify(effective),
      );
      api.requireTrue(
        record(record(JSON.parse(readFileSync(globalPath, "utf8"))).sfPi).tldraw !== undefined,
        "global sfPi.tldraw not persisted",
      );
      return { globalPath, projectPath, sources: effective.sources };
    } finally {
      clearTldrawPreference(workspace, "global", "ldvThreshold");
      const cleared = clearTldrawPreference(workspace, "project", "cardFill");
      api.requireTrue(
        cleared.sources.cardFill.scope === "default" &&
          cleared.sources.ldvThreshold.scope === "default",
        `preferences not cleared: ${JSON.stringify(cleared.sources)}`,
      );
    }
  });

  await api.run("tldraw.command.headless-rpc", ID, async () => {
    const command = api.command(ID);
    api.requireTrue(command?.extension === ID, "/sf-tldraw not registered by sf-tldraw");
    const ctx = api.ctx as {
      hasUI: boolean;
      mode: string;
      sessionManager: { getBranch(): Array<{ type: string; customType?: string; data?: Json }> };
    };
    api.requireTrue(ctx.hasUI === false && ctx.mode === "rpc", `smoke ctx ${ctx.mode}`);
    const outputs = () =>
      ctx.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === ID);
    const printed: string[] = [];
    const info = console.info;
    console.info = (...values: unknown[]) => printed.push(values.map(String).join(" "));
    // RPC stdout is the protocol channel: output must land in a human-only session entry.
    const run = async (args: string): Promise<string> => {
      const before = outputs().length;
      await offline(missingConfig, () => command.handler(args, api.ctx));
      const after = outputs();
      api.requireTrue(printed.length === 0, `/sf-tldraw ${args} wrote stdout: ${printed[0]}`);
      api.requireTrue(after.length === before + 1, `/sf-tldraw ${args}: no session output entry`);
      return String(after.at(-1)?.data?.body);
    };
    try {
      writeTldrawPreference(api.workspace, "project", "cardFill", "family");
      const noArgs = await run("");
      api.requireTrue(
        noArgs.includes("- Runtime: not-running") && noArgs.includes("Card fill: family"),
        noArgs,
      );
      const status = await run("status");
      api.requireTrue(status === noArgs, "no-args and status outputs differ");
      const help = await run("help");
      api.requireTrue(help.startsWith("# SF tldraw") && help.includes("/sf-tldraw status"), help);
      const cheatsheet = await run("cheatsheet");
      api.requireTrue(
        cheatsheet ===
          redactDisplayText(
            readFileSync(path.join(EXTENSION_DIR, "docs", "cheatsheet.md"), "utf8").trim(),
          ),
        "command cheatsheet differs",
      );
      const documents = await run("documents");
      api.requireTrue(documents.startsWith("No tldraw documents are open."), documents);
      const unknown = await run("bogus");
      api.requireTrue(unknown.includes("Unknown /sf-tldraw subcommand: bogus"), unknown);
      const completions = command.getArgumentCompletions?.("") as Array<{ value: string }> | null;
      api.requireTrue(
        ["status", "documents", "cheatsheet", "help"].every((value) =>
          completions?.some((item) => item.value.trim() === value),
        ),
        JSON.stringify(completions),
      );
      return { noArgs: noArgs.split("\n")[1], completions: completions?.map((item) => item.value) };
    } finally {
      console.info = info;
      clearTldrawPreference(api.workspace, "project", "cardFill");
    }
  });

  await api.run("tldraw.command.ui-notify", ID, async () => {
    const command = api.command(ID);
    api.requireTrue(command, "/sf-tldraw not registered");
    const notes: Array<{ message: string; level?: string }> = [];
    const base = api.ctx as object;
    const baseUi = Reflect.get(base, "ui") as object;
    const ui = new Proxy(baseUi, {
      get: (target, key) =>
        key === "notify"
          ? (message: string, level?: string) => notes.push({ message, level })
          : Reflect.get(target, key),
    });
    const ctx = new Proxy(base, {
      get: (target, key) => (key === "hasUI" ? true : key === "ui" ? ui : Reflect.get(target, key)),
    });
    await offline(missingConfig, () => command.handler("status", ctx));
    const [note] = notes;
    api.requireTrue(
      notes.length === 1 &&
        note?.level === "warning" &&
        note.message.includes("- Runtime: not-running"),
      JSON.stringify(notes),
    );
    return { level: note.level };
  });

  api.requireTrue(fetches === 0, "tldraw smoke checks attempted network access.");

  await liveChecks(api, { tldraw, text, artifactsRoot });
}

interface Helpers {
  tldraw(result: unknown): Json;
  text(result: unknown): string;
  artifactsRoot: string;
}

const LIVE_PREFIX = "tldraw.live";
const PROVISION_STEPS =
  "Run `bun scripts/provision-tldraw-office.ts` (pinned, sha256- and signature-verified tldraw office release under .runtime/toolchains/tldraw-office; macOS only), then rerun `npm run smoke:omp`.";
const STARTUP_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;

/**
 * Real renders through the provisioned tldraw office app: launched hidden with a hermetic
 * TEST_DATA_DIR under this smoke run, reached only over its loopback Canvas API, and always
 * stopped (finally, process exit, and a parent-death watchdog).
 */
async function liveChecks(api: SmokeApi, helpers: Helpers): Promise<void> {
  const toolchain = tldrawOfficeToolchain();
  if (process.platform !== "darwin" || !toolchain.executable) {
    for (const name of ["status", "documents", "create_document", "render"]) {
      api.skip(
        `${LIVE_PREFIX}.${name}`,
        ID,
        "blocked",
        `tldraw office ${toolchain.version} runtime is not provisioned. ${PROVISION_STEPS}`,
      );
    }
    return;
  }

  // Smoke HOME is hermetic, but cfprefsd and the per-user temp dir follow the real account.
  const realHome = /NFSHomeDirectory:\s*(\S+)/.exec(
    spawnSync("dscl", [".", "-read", `/Users/${os.userInfo().username}`, "NFSHomeDirectory"], {
      encoding: "utf8",
    }).stdout,
  )?.[1];
  if (!realHome) throw new Error("Could not resolve the account home directory.");
  const preferencesPlist = path.join(
    realHome,
    "Library",
    "Preferences",
    "com.tldraw.desktop.plist",
  );
  const appSupport = path.join(realHome, "Library", "Application Support");
  const captureDir = path.join(os.tmpdir(), "tldraw-agent-api");
  const listTldrawAppSupport = () =>
    readdirSync(appSupport).filter((name) => name.toLowerCase().startsWith("tldraw"));
  const listCaptures = () => new Set(existsSync(captureDir) ? readdirSync(captureDir) : []);
  const before = {
    plist: existsSync(preferencesPlist),
    appSupport: listTldrawAppSupport(),
    captures: listCaptures(),
  };

  const runRoot = path.join(path.dirname(api.workspace), "tldraw-office");
  const dataDir = path.join(runRoot, "data");
  const userData = path.join(dataDir, "electron-user-data");
  const serverJson = path.join(userData, "server.json");
  mkdirSync(userData, { recursive: true });
  // No updater traffic from the smoke instance.
  writeFileSync(
    path.join(userData, "config.json"),
    `${JSON.stringify({ userPreferences: { autoCheckUpdates: false } })}\n`,
  );
  const log = openSync(path.join(runRoot, "app.log"), "a");
  const app = spawn(toolchain.executable, ["--proxy-server=127.0.0.1:9"], {
    env: { ...process.env, TEST_DATA_DIR: dataDir, TLDRAW_HIDE_WINDOWS: "1" },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  const appPid = app.pid;
  const killApp = () => {
    if (app.exitCode === null && app.signalCode === null) app.kill("SIGKILL");
  };
  process.once("exit", killApp);
  // Survives a SIGKILL of this OMP child, which skips exit handlers.
  const watchdog = spawn(
    "/bin/sh",
    [
      "-c",
      `while kill -0 ${process.pid} 2>/dev/null && kill -0 ${appPid} 2>/dev/null; do sleep 1; done; kill -9 ${appPid} 2>/dev/null`,
    ],
    { detached: true, stdio: "ignore" },
  );
  watchdog.unref();

  const previousEnv = process.env.TLDRAW_SERVER_CONFIG;
  const guardedFetch = globalThis.fetch;
  try {
    let config: Json = {};
    await api.run(`${LIVE_PREFIX}.startup`, ID, async () => {
      const started = Date.now();
      while (Date.now() - started < STARTUP_TIMEOUT_MS) {
        if (app.exitCode !== null) throw new Error(`tldraw office exited (${app.exitCode})`);
        if (existsSync(serverJson)) {
          config = record(JSON.parse(readFileSync(serverJson, "utf8")));
          if (config.pid === appPid) break;
        }
        await sleep(250);
      }
      api.requireTrue(
        config.pid === appPid && Number.isInteger(config.port),
        `tldraw office did not publish ${serverJson} within ${STARTUP_TIMEOUT_MS}ms`,
      );
      return { version: toolchain.version, port: config.port, ms: Date.now() - started };
    });
    if (config.pid !== appPid) return;

    // Only this app's loopback origin bypasses the smoke's outbound fetch guard.
    const origin = `http://127.0.0.1:${String(config.port)}/`;
    process.env.TLDRAW_SERVER_CONFIG = serverJson;
    globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.startsWith(origin) ? Bun.fetch(input, init) : guardedFetch(input, init);
    }, guardedFetch);

    await liveRuntimeChecks(api, helpers);
  } finally {
    globalThis.fetch = guardedFetch;
    if (previousEnv === undefined) delete process.env.TLDRAW_SERVER_CONFIG;
    else process.env.TLDRAW_SERVER_CONFIG = previousEnv;
    if (app.exitCode === null && app.signalCode === null) {
      const exited = once(app, "exit");
      app.kill("SIGTERM");
      await Promise.race([exited, sleep(STOP_TIMEOUT_MS)]);
      // Quit can stall on unsaved rendered documents; SIGKILL is the bounded fallback.
      if (app.exitCode === null && app.signalCode === null) {
        killApp();
        await Promise.race([exited, sleep(STOP_TIMEOUT_MS)]);
      }
    }
    process.removeListener("exit", killApp);
    if (watchdog.exitCode === null) watchdog.kill("SIGKILL");
    await api.run(`${LIVE_PREFIX}.host-isolation`, ID, async () => {
      // The app keeps capture sources in the per-user OS temp dir (Electron temp path) and
      // AppKit writes default keys through cfprefsd; neither honors HOME, so remove what this
      // run created.
      const created = [...listCaptures()].filter((name) => !before.captures.has(name));
      for (const name of created) rmSync(path.join(captureDir, name), { force: true });
      let plistRemoved = false;
      if (!before.plist && existsSync(preferencesPlist)) {
        spawnSync("defaults", ["delete", "com.tldraw.desktop"]);
        rmSync(preferencesPlist, { force: true });
        plistRemoved = true;
      }
      const appSupportNow = listTldrawAppSupport();
      api.requireTrue(
        JSON.stringify(appSupportNow) === JSON.stringify(before.appSupport),
        `tldraw office wrote to ${appSupport}: ${JSON.stringify(appSupportNow)}`,
      );
      api.requireTrue(
        app.exitCode !== null || app.signalCode !== null,
        "tldraw office still running",
      );
      api.requireTrue(existsSync(preferencesPlist) === before.plist, "preferences plist leaked");
      return {
        removedCaptures: created.length,
        plistRemoved,
        appExit: app.exitCode ?? app.signalCode,
      };
    });
  }
}

async function liveRuntimeChecks(api: SmokeApi, { tldraw, text, artifactsRoot }: Helpers) {
  let documentId = "";
  await api.run(`${LIVE_PREFIX}.status`, ID, async () => {
    const result = await api.requireSuccess(TOOL, { action: "status" });
    const status = record(tldraw(result).status);
    const capabilities = record(status.capabilities);
    api.requireTrue(
      status.kind === "no-open-document" &&
        capabilities.apiContract === "canvas-api-v1.12" &&
        capabilities.execute === true &&
        capabilities.screenshot === true &&
        capabilities.nativeDocumentCreation === true,
      JSON.stringify(status),
    );
    return { kind: status.kind, capabilities };
  });

  await api.run(`${LIVE_PREFIX}.create_document`, ID, async () => {
    const result = await api.requireSuccess(TOOL, {
      action: "create_document",
      name: "SF Smoke Diagrams",
    });
    const document = record(tldraw(result).document);
    api.requireTrue(typeof document.id === "string" && document.id, JSON.stringify(result));
    documentId = String(document.id);
    api.requireTrue(text(result).includes(`Document id: ${documentId}`), text(result));
    return { name: document.name };
  });
  if (!documentId) return;

  await api.run(`${LIVE_PREFIX}.documents`, ID, async () => {
    const result = await api.requireSuccess(TOOL, { action: "documents" });
    const documents = (tldraw(result).documents as Json[] | undefined) ?? [];
    api.requireTrue(
      documents.some((document) => document.id === documentId),
      JSON.stringify(documents),
    );
    const command = api.command(ID);
    api.requireTrue(command, "/sf-tldraw not registered");
    await command.handler("status", api.ctx);
    const ctx = api.ctx as {
      sessionManager: { getBranch(): Array<{ type: string; customType?: string; data?: Json }> };
    };
    const body = String(
      ctx.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === ID)
        .at(-1)?.data?.body,
    );
    api.requireTrue(body.includes("- Runtime: ready") && body.includes("SF Smoke Diagrams"), body);
    return { documents: documents.length, command: body.split("\n")[1] };
  });

  for (const [action, name, page] of [
    ["render_salesforce_data_model", "data-model", "Smoke Data Model"],
    ["render_salesforce_architecture", "architecture", "Smoke Architecture"],
    ["render_salesforce_sequence", "sequence", "Smoke Sequence"],
  ] as const) {
    await api.run(`${LIVE_PREFIX}.render.${name}`, ID, async () => {
      const spec = fixture(name);
      const result = await api.requireSuccess(TOOL, {
        action,
        spec,
        document_id: documentId,
        page_name: page,
        render_mode: "replace",
      });
      const details = tldraw(result);
      const outcome = record(details.result);
      const readiness = record(outcome.readiness);
      const artifact = record(details.artifact);
      api.requireTrue(
        readiness.ready === true &&
          readiness.lintCount === 0 &&
          Array.isArray(readiness.blockers) &&
          readiness.blockers.length === 0 &&
          outcome.documentId === documentId &&
          outcome.pageName === page &&
          Number(outcome.createdShapes) > 0,
        `render outcome: ${JSON.stringify({ outcome, artifact }).slice(0, 2000)}`,
      );
      const reportPath = String(artifact.reportPath);
      api.requireTrue(
        reportPath.startsWith(`${path.join(artifactsRoot, "runs")}${path.sep}`) &&
          path.basename(reportPath) === "report.json",
        `artifact outside hermetic agent dir: ${reportPath}`,
      );
      const report = record(record(JSON.parse(readFileSync(reportPath, "utf8"))).state);
      const nodes = record(spec)[
        name === "data-model" ? "objects" : name === "architecture" ? "systems" : "participants"
      ] as unknown[];
      api.requireTrue(
        report.family === spec.family &&
          report.title === spec.title &&
          report.documentId === documentId &&
          report.pageName === page &&
          report.nodeCount === nodes.length &&
          record(report.readiness).ready === true &&
          record(report.readiness).lintCount === 0 &&
          (record(report.evidence).sources as unknown[]).length > 0 &&
          !JSON.stringify(report).includes("target_org"),
        `report.json: ${JSON.stringify(report).slice(0, 1500)}`,
      );
      const images: Record<string, number> = {};
      for (const key of ["screenshotPath", "thumbnailPath"]) {
        const file = String(artifact[key]);
        api.requireTrue(path.dirname(file) === path.dirname(reportPath), `${key}: ${file}`);
        const bytes = readFileSync(file);
        const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        const png = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        api.requireTrue(bytes.length > 1_000 && (jpeg || png), `${key} is not an image`);
        api.requireTrue((statSync(file).mode & 0o777) === 0o600, `${key} is not private`);
        images[key] = bytes.length;
      }
      const content = (record(result).content as Json[] | undefined) ?? [];
      api.requireTrue(
        content.some((item) => item.type === "image" && typeof item.data === "string"),
        "summary render returned no thumbnail image content",
      );
      return {
        runDir: path.basename(path.dirname(reportPath)),
        shapes: outcome.createdShapes,
        markerChecks: (readiness.markerChecks as unknown[] | undefined)?.length,
        warnings: (readiness.warnings as unknown[] | undefined)?.length,
        images,
      };
    });
  }

  await api.run(`${LIVE_PREFIX}.render.preserve-rerender`, ID, async () => {
    const result = await api.requireSuccess(TOOL, {
      action: "render_salesforce_data_model",
      spec: fixture("data-model"),
      document_id: documentId,
      page_name: "Smoke Data Model",
      output_mode: "file_only",
    });
    const outcome = record(tldraw(result).result);
    api.requireTrue(
      record(outcome.readiness).ready === true &&
        outcome.createdShapes === 0 &&
        Number(outcome.updatedShapes) > 0 &&
        outcome.deletedShapes === 0 &&
        !((record(result).content as Json[] | undefined) ?? []).some(
          (item) => item.type === "image",
        ),
      JSON.stringify(outcome).slice(0, 1500),
    );
    return { updated: outcome.updatedShapes };
  });
}
