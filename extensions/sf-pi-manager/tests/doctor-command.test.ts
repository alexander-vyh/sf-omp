/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Tests for the per-extension doctor aggregation rendering inside
 * `/sf-pi doctor`. Pins the shape so future ADR-0006 follow-ups don't
 * accidentally drift the user-visible block.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleDoctor, renderExtensionOutcomes } from "../lib/doctor-command.ts";
import type { RegisteredDoctorOutcome } from "../../../lib/common/doctor/registry.ts";

const SAMPLE_OUTCOMES: RegisteredDoctorOutcome[] = [
  {
    extensionId: "sf-alpha",
    status: "ok",
    durationMs: 12,
    report: {
      extensionId: "sf-alpha",
      title: "SF Alpha",
      summary: "✓ ok",
      durationMs: 12,
      checks: [
        {
          id: "alpha.basic",
          severity: "ok",
          title: "Alpha basic check",
          detail: "All good",
        },
        {
          id: "alpha.warn",
          severity: "warn",
          title: "Alpha needs attention",
          detail: "Token rotated less than 24h ago",
          fix: "Run /alpha refresh",
        },
      ],
    },
  },
  {
    extensionId: "sf-bad",
    status: "error",
    durationMs: 4,
    error: "kaboom",
  },
  {
    extensionId: "sf-slow",
    status: "timeout",
    durationMs: 5_001,
  },
];

vi.mock("../../../lib/common/doctor/diagnostics.ts", () => ({
  runDoctorDiagnostics: () => ({
    ompVersion: "19.2.1",
    nodeVersion: "v22.19.0",
    runtime: { ompVersion: "19.2.1", nodeVersion: "v22.19.0", nodePath: "/usr/local/bin/node" },
    welcomeMode: "header",
    safeStartRequested: false,
    welcomeDisabled: false,
    issues: [],
    skillCollisions: [],
    staleSkillPaths: [],
    availableSkillRoots: [],
  }),
}));
vi.mock("../../../lib/common/doctor/registry.ts", () => ({
  runRegisteredDoctors: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../../lib/common/doctor/fixes.ts", () => ({
  applyDoctorFixes: () => ({
    changed: true,
    messages: ["Updated startup settings."],
    quarantinedSkills: [],
  }),
}));

describe("handleDoctor", () => {
  it("reports that fix reloaded the runtime so callers do not reuse the stale ctx", async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      cwd: "/tmp/sf-pi-doctor-test",
      hasUI: false,
      ui: { notify: vi.fn() },
      reload,
    };

    await expect(
      handleDoctor(ctx as unknown as ExtensionCommandContext, {
        subcommand: "fix",
        target: "startup",
      }),
    ).resolves.toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reports the OMP host and the sf-omp recovery launcher in status", async () => {
    const notify = vi.fn();
    const ctx = {
      cwd: "/tmp/sf-pi-doctor-test",
      hasUI: false,
      ui: { notify },
      reload: vi.fn(),
    };

    await handleDoctor(ctx as unknown as ExtensionCommandContext, { subcommand: "status" });

    expect(notify).toHaveBeenCalledOnce();
    const [text, level] = notify.mock.calls[0] as [string, string];
    expect(level).toBe("info");
    expect(text).toContain("Host runtime:     OMP 19.2.1 (sf-omp host)");
    expect(text).toContain("✓ No setup issues detected.");
    expect(text).toMatch(/Recovery launch: SF_PI_SAFE_START=1 \S*tools[/\\]bin[/\\]omp$/m);
  });

  it("reports the native OMP runtime and its update command", async () => {
    const notify = vi.fn();
    const ctx = {
      cwd: "/tmp/sf-pi-doctor-test",
      hasUI: false,
      ui: { notify },
      reload: vi.fn(),
    };

    await handleDoctor(ctx as unknown as ExtensionCommandContext, { subcommand: "runtime" });

    expect(notify).toHaveBeenCalledWith(
      [
        "sf-pi Runtime Doctor",
        "",
        "Host runtime:     OMP 19.2.1 (sf-omp host)",
        "Node.js:          v22.19.0",
        "Node executable:  /usr/local/bin/node",
        "",
        "Update OMP: omp update --check, then omp update",
      ].join("\n"),
      "info",
    );
  });
});

describe("renderExtensionOutcomes", () => {
  it("renders OK outcomes with their per-check rows and summaries", () => {
    const text = renderExtensionOutcomes([SAMPLE_OUTCOMES[0]!]);
    expect(text).toContain("Extension diagnostics:");
    expect(text).toContain("SF Alpha");
    expect(text).toContain("✓ Alpha basic check");
    expect(text).toContain("! Alpha needs attention");
    expect(text).toContain("Fix: Run /alpha refresh");
  });

  it("surfaces error outcomes inline without blocking the rest of the report", () => {
    const text = renderExtensionOutcomes(SAMPLE_OUTCOMES);
    expect(text).toContain("sf-bad — errored: kaboom");
    expect(text).toContain("sf-slow — timed out after 5001ms");
    // OK outcomes still appear alongside failures.
    expect(text).toContain("SF Alpha");
  });

  it("returns just the heading when given an empty list", () => {
    const text = renderExtensionOutcomes([]);
    expect(text).toBe("Extension diagnostics:");
  });
});
