/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Mirror Gateway model-selection settings into OMP's own config.
 *
 * Pi reads `defaultProvider`/`defaultModel` and `enabledModels` from
 * settings.json. OMP ignores that file for model selection: it reads
 * `modelRoles.default` ("provider/modelId") and `enabledModels` (patterns that
 * filter the exposed model list) from `<agentDir>/config.yml` (global) or
 * `<cwd>/.omp/config.yml` (project). SF Pi keeps settings.json as its record
 * and projects exactly those keys into OMP's file, then has OMP's live
 * settings reload so the change applies in-session and after restart.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { parseDocument } from "yaml";
import { PROVIDER_NAME } from "./config.ts";

/** The live OMP `Settings` members used here (absent from Pi's SettingsManager). */
interface OmpLiveSettings {
  getAgentDir(): string;
  reloadFromDisk(): Promise<void>;
}

export type OmpSettingsScope = { scope: "global" } | { scope: "project"; cwd: string };

function asOmpLiveSettings(value: unknown): OmpLiveSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (!("getAgentDir" in value) || typeof value.getAgentDir !== "function") return undefined;
  if (!("reloadFromDisk" in value) || typeof value.reloadFromDisk !== "function") return undefined;
  if (!("setModelRole" in value) || typeof value.setModelRole !== "function") return undefined;
  // Member checks above prove OMP's Settings surface; a class cannot narrow from `in`.
  const live = value as OmpLiveSettings;
  return live;
}

/** OMP config file for a scope: an existing `config.yaml` wins, else `config.yml`. */
export function ompConfigPath(agentDir: string, target: OmpSettingsScope): string {
  const dir = target.scope === "global" ? agentDir : path.join(target.cwd, ".omp");
  const yaml = path.join(dir, "config.yaml");
  return existsSync(yaml) ? yaml : path.join(dir, "config.yml");
}

/**
 * Project Pi model-selection keys onto an OMP config document. Present keys are
 * written; absent keys are removed only when OMP's value is Gateway-owned, so a
 * user's own OMP default or model scope is never cleared. Other keys are untouched.
 */
export function projectModelSelectionToOmpConfig(
  source: string,
  settings: Record<string, unknown>,
): string {
  const doc = parseDocument(source);
  const enabled = Array.isArray(settings.enabledModels)
    ? settings.enabledModels.filter((item): item is string => typeof item === "string")
    : [];
  const current: unknown = doc.toJS();
  const currentEnabled =
    current && typeof current === "object" && "enabledModels" in current
      ? current.enabledModels
      : undefined;
  // Gateway-owned scope: only Gateway patterns, as written by an exclusive `on`.
  const gatewayOwnedScope =
    Array.isArray(currentEnabled) &&
    currentEnabled.every(
      (pattern) => typeof pattern === "string" && pattern.startsWith(`${PROVIDER_NAME}/`),
    );
  if (enabled.length > 0) doc.setIn(["enabledModels"], enabled);
  else if (gatewayOwnedScope) doc.deleteIn(["enabledModels"]);

  const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : "";
  const modelId = typeof settings.defaultModel === "string" ? settings.defaultModel : "";
  const currentDefault: unknown = doc.getIn(["modelRoles", "default"]);
  if (provider && modelId) doc.setIn(["modelRoles", "default"], `${provider}/${modelId}`);
  else if (typeof currentDefault === "string" && currentDefault.startsWith(`${PROVIDER_NAME}/`))
    doc.deleteIn(["modelRoles", "default"]);
  return doc.contents === null ? source : doc.toString();
}

/**
 * On OMP, write the selection keys of a just-saved Pi settings object into the
 * matching OMP config and reload OMP's live settings. No-op on Pi.
 */
export function mirrorModelSelectionToOmp(
  target: OmpSettingsScope,
  settings: Record<string, unknown>,
): string | undefined {
  // OMP's shim exports a factory object; Pi's SettingsManager is a class whose
  // construction reads (and may migrate) Pi files, so never build one here.
  const manager: unknown = SettingsManager;
  if (typeof manager !== "object" || manager === null || !("create" in manager)) return undefined;
  if (typeof manager.create !== "function") return undefined;
  const live = asOmpLiveSettings(
    Reflect.apply(manager.create, manager, [target.scope === "project" ? target.cwd : undefined]),
  );
  if (!live) return undefined;
  const filePath = ompConfigPath(live.getAgentDir(), target);
  const current = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const next = projectModelSelectionToOmpConfig(current, settings);
  if (next !== current) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, next);
  }
  void live.reloadFromDisk().catch(() => undefined);
  return filePath;
}
