/* SPDX-License-Identifier: Apache-2.0 */
/** Native OMP mode proofs for display-only command reports. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  OMP_ISOLATION_ARGS,
  OMP_OFFLINE_MODEL_ARGS,
  OMP_SESSION_ENTRIES_PROBE,
  REPO_ROOT,
  ompTestHost,
} from "./omp-host.ts";

/** Generous ceiling for a cold OMP start that transpiles the extension. */
const RUN_TIMEOUT_MS = 30_000;
const tempDirs: string[] = [];

/** label, extension, command, report customType, report marker */
const REPORTS = [
  [
    "SF Feedback",
    "extensions/sf-feedback/index.ts",
    "/sf-feedback help",
    "sf-feedback",
    "/sf-feedback subcommands",
  ],
  [
    "Gateway",
    "extensions/sf-llm-gateway/index.ts",
    "/sf-llm-gateway help",
    "sf-llm-gateway",
    "/sf-llm-gateway with no args",
  ],
] as const;

interface SessionEntry {
  type?: string;
  customType?: string;
  data?: { body?: string };
}

function runOmp(extensionPath: string, modeArgs: string[], command: string, input?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "sf-omp-human-output-"));
  tempDirs.push(root);
  const entriesPath = path.join(root, "entries.json");
  const host = ompTestHost(root, { SF_OMP_PROBE_ENTRIES: entriesPath });
  const [executable, ...cli] = host.command;
  const args = [
    ...cli,
    ...OMP_ISOLATION_ARGS,
    ...OMP_OFFLINE_MODEL_ARGS,
    "-e",
    path.join(REPO_ROOT, extensionPath),
    "-e",
    OMP_SESSION_ENTRIES_PROBE,
    ...modeArgs,
  ];
  if (command) args.push(command);

  const result = spawnSync(executable, args, {
    cwd: root,
    env: host.env,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    input,
  });
  return {
    ...result,
    events: () =>
      result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    /** Session entries the probe recorded at shutdown. */
    entries: () => JSON.parse(readFileSync(entriesPath, "utf8")) as SessionEntry[],
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("human-only command output through native OMP modes", () => {
  it.each(REPORTS)(
    "records %s JSON-mode output as an entry, never a custom message",
    (_label, extensionPath, command, customType, marker) => {
      const result = runOmp(extensionPath, ["--mode", "json", "--print"], command);

      expect(result.status, result.stderr).toBe(0);
      expect(result.events().some((event) => event.type === "message_start")).toBe(false);
      // OMP's JSON stream does not publish appended entries; read the session itself.
      const entries = result.entries();
      const report = entries.find(
        (entry) => entry.type === "custom" && entry.customType === customType,
      );
      expect(report?.data?.body).toContain(marker);
      expect(
        entries.filter((entry) => entry.type === "message" || entry.type === "custom_message"),
      ).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );

  it.each(REPORTS)(
    "emits %s reports through the RPC notification channel",
    (_label, extensionPath, command, _customType, marker) => {
      const request = `${JSON.stringify({ id: "report", type: "prompt", message: command })}\n`;
      const result = runOmp(extensionPath, ["--mode", "rpc"], "", request);

      expect(result.status, result.stderr).toBe(0);
      const events = result.events();
      const notification = events.find(
        (event) => event.type === "extension_ui_request" && event.method === "notify",
      ) as { message?: string } | undefined;

      expect(notification?.message).toContain(marker);
      expect(events.some((event) => event.type === "message_start")).toBe(false);
    },
    RUN_TIMEOUT_MS,
  );

  it.each(REPORTS)(
    "prints %s reports in print mode",
    (_label, extensionPath, command, _customType, marker) => {
      const result = runOmp(extensionPath, ["--print"], command);

      expect(result.status, result.stderr).toBe(0);
      // OMP prints extension console output to stdout and progress to stderr;
      // either stream is human-visible.
      expect(`${result.stdout}\n${result.stderr}`).toContain(marker);
    },
    RUN_TIMEOUT_MS,
  );
});
