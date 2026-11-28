/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Tests for the splash CA-bundle nudge gate.
 *
 * Asserts the four mutually-exclusive paths through the gate:
 *   1. extension disabled \u2192 no nudge (regardless of probe state)
 *   2. fix already applied \u2192 no nudge
 *   3. probe state doesn't match macOS-no-bundle pattern \u2192 no nudge
 *   4. all three gates pass \u2192 nudge surfaces with stable command + message
 *
 * Each test uses pathOverrides for the two state files. The
 * isSfPiExtensionEnabled gate reads OMP's `disabledExtensions` config, so
 * PI_CODING_AGENT_DIR is redirected to keep the user's global config.yml out.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectCaBundleNudge } from "../lib/ca-bundle-nudge.ts";

const PI_AGENT_ENV = "PI_CODING_AGENT_DIR";

let tmpDir: string;
let prevAgentDir: string | undefined;

function probeStatePath(): string {
  return path.join(tmpDir, "ca-probe.json");
}

function fixerStatePath(): string {
  return path.join(tmpDir, "ca-bundle-fixer.json");
}

/** Write the on-disk envelope shape used by lib/common/state-store.ts. */
function writeEnvelope(filePath: string, state: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ schemaVersion: 1, state }, null, 2)}\n`, "utf8");
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "sf-pi-ca-nudge-"));
  prevAgentDir = process.env[PI_AGENT_ENV];
  process.env[PI_AGENT_ENV] = tmpDir;
});

afterEach(() => {
  if (prevAgentDir === undefined) delete process.env[PI_AGENT_ENV];
  else process.env[PI_AGENT_ENV] = prevAgentDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("collectCaBundleNudge", () => {
  it("returns the nudge when probe says tls + darwin + no NODE_EXTRA_CA_CERTS + extension enabled + no fix", () => {
    writeEnvelope(probeStatePath(), {
      at: "2026-05-17T10:00:00.000Z",
      lastFailureClass: "tls",
      hasNodeExtraCaCerts: false,
      platform: "darwin",
    });
    // No fixer state file = "never applied" \u2014 the canonical first-run state.

    const nudge = collectCaBundleNudge({
      cwd: tmpDir,
      probeStatePathOverride: probeStatePath(),
      fixerStatePathOverride: fixerStatePath(),
    });
    expect(nudge).toBeDefined();
    expect(nudge?.command).toBe("/sf-llm-gateway fix-ca-bundle");
    expect(nudge?.message).toContain("LaunchAgent");
    expect(nudge?.message).toContain("~/.zshenv");
  });

  it("hides when the gateway extension is disabled in OMP config", () => {
    // OMP's disable mechanism, as the sf-pi-manager writes it: an
    // `extension-module:<id>` entry in the project `.omp/config.yml`.
    mkdirSync(path.join(tmpDir, ".omp"), { recursive: true });
    writeFileSync(
      path.join(tmpDir, ".omp", "config.yml"),
      "disabledExtensions:\n  - extension-module:sf-llm-gateway\n",
      "utf8",
    );
    writeEnvelope(probeStatePath(), {
      at: "2026-05-17T10:00:00.000Z",
      lastFailureClass: "tls",
      hasNodeExtraCaCerts: false,
      platform: "darwin",
    });

    const nudge = collectCaBundleNudge({
      cwd: tmpDir,
      probeStatePathOverride: probeStatePath(),
      fixerStatePathOverride: fixerStatePath(),
    });
    expect(nudge).toBeUndefined();
  });

  it("hides once the fix has been applied, even if probe still says tls", () => {
    writeEnvelope(probeStatePath(), {
      at: "2026-05-17T10:00:00.000Z",
      lastFailureClass: "tls",
      hasNodeExtraCaCerts: false,
      platform: "darwin",
    });
    writeEnvelope(fixerStatePath(), {
      appliedAt: "2026-05-17T10:05:00.000Z",
      bundlePath: "/Users/test/.aisuite/conf/internal.pem",
      plistPath: "/Users/test/Library/LaunchAgents/com.salesforce.sf-pi.node-extra-ca-certs.plist",
      source: "adopt",
    });

    const nudge = collectCaBundleNudge({
      cwd: tmpDir,
      probeStatePathOverride: probeStatePath(),
      fixerStatePathOverride: fixerStatePath(),
    });
    expect(nudge).toBeUndefined();
  });

  it("hides on Linux even when the failure class is tls", () => {
    writeEnvelope(probeStatePath(), {
      at: "2026-05-17T10:00:00.000Z",
      lastFailureClass: "tls",
      hasNodeExtraCaCerts: false,
      platform: "linux",
    });

    const nudge = collectCaBundleNudge({
      cwd: tmpDir,
      probeStatePathOverride: probeStatePath(),
      fixerStatePathOverride: fixerStatePath(),
    });
    expect(nudge).toBeUndefined();
  });

  it("hides when NODE_EXTRA_CA_CERTS was already wired up at probe time", () => {
    writeEnvelope(probeStatePath(), {
      at: "2026-05-17T10:00:00.000Z",
      lastFailureClass: "tls",
      hasNodeExtraCaCerts: true,
      platform: "darwin",
    });

    const nudge = collectCaBundleNudge({
      cwd: tmpDir,
      probeStatePathOverride: probeStatePath(),
      fixerStatePathOverride: fixerStatePath(),
    });
    expect(nudge).toBeUndefined();
  });

  it("hides when the probe verdict is non-tls (auth/redirect/other/null)", () => {
    for (const failureClass of ["auth", "redirect", "other", null] as const) {
      writeEnvelope(probeStatePath(), {
        at: "2026-05-17T10:00:00.000Z",
        lastFailureClass: failureClass,
        hasNodeExtraCaCerts: false,
        platform: "darwin",
      });
      const nudge = collectCaBundleNudge({
        cwd: tmpDir,
        probeStatePathOverride: probeStatePath(),
        fixerStatePathOverride: fixerStatePath(),
      });
      expect(nudge, `failureClass=${failureClass}`).toBeUndefined();
    }
  });

  it("hides when the probe has never run (no state file)", () => {
    const nudge = collectCaBundleNudge({
      cwd: tmpDir,
      probeStatePathOverride: probeStatePath(),
      fixerStatePathOverride: fixerStatePath(),
    });
    expect(nudge).toBeUndefined();
  });
});
