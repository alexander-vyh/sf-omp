/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Version-gate unit tests for pi-compat.
 *
 * Covers the semver-ish comparator and the documented precedence rules used
 * by `requirePiVersion` without trying to stub out `readFileSync`. The
 * console.warn-capture test exercises the public behavior agent authors care
 * about: on an older pi the gate returns false AND logs exactly one line per
 * extension name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDITED_MAX_PI_VERSION_EXCLUSIVE,
  classifyPiVersion,
  compareVersions,
  getInstalledPiVersion,
  HARD_MAX_PI_VERSION_EXCLUSIVE,
  isPiVersionLoadable,
  MIN_PI_VERSION,
  RECOMMENDED_PI_VERSION,
  requirePiVersion,
} from "../pi-compat.ts";

describe("compareVersions", () => {
  it("returns 0 for equal full-release versions", () => {
    expect(compareVersions("0.72.0", "0.72.0")).toBe(0);
  });

  it("orders patch releases correctly", () => {
    expect(compareVersions("0.72.1", "0.72.0")).toBeGreaterThan(0);
    expect(compareVersions("0.72.0", "0.72.1")).toBeLessThan(0);
  });

  it("orders minor releases correctly", () => {
    expect(compareVersions("0.72.0", "0.71.9")).toBeGreaterThan(0);
    expect(compareVersions("0.70.6", "0.72.0")).toBeLessThan(0);
  });

  it("treats a prerelease as older than the same core full release", () => {
    // Matches how our gate should interpret "0.72.0-rc.1" < "0.72.0".
    expect(compareVersions("0.72.0-rc.1", "0.72.0")).toBeLessThan(0);
    expect(compareVersions("0.72.0", "0.72.0-rc.1")).toBeGreaterThan(0);
  });

  it("ignores SemVer build metadata, including hyphens", () => {
    expect(compareVersions("0.82.0+build-1", "0.82.0")).toBe(0);
  });

  it("pads short inputs with zeroes so '0.72' == '0.72.0'", () => {
    expect(compareVersions("0.72", "0.72.0")).toBe(0);
  });
});

describe("Pi compatibility policy", () => {
  it("distinguishes audited, forward-compatible, and blocked releases", () => {
    expect(MIN_PI_VERSION).toBe("1.5.1");
    expect(AUDITED_MAX_PI_VERSION_EXCLUSIVE).toBe("1.5.3");
    expect(HARD_MAX_PI_VERSION_EXCLUSIVE).toBe("2.0.0");
    expect(RECOMMENDED_PI_VERSION).toBe("1.5.2");

    expect(classifyPiVersion("0.99.2")).toBe("too-old");
    expect(classifyPiVersion("1.0.0")).toBe("too-old");
    expect(classifyPiVersion("1.0.1")).toBe("too-old");
    expect(classifyPiVersion("1.0.2")).toBe("too-old");
    expect(classifyPiVersion("1.0.3")).toBe("too-old");
    expect(classifyPiVersion("1.0.4")).toBe("too-old");
    expect(classifyPiVersion("1.1.0")).toBe("too-old");
    expect(classifyPiVersion("1.2.0")).toBe("too-old");
    expect(classifyPiVersion("1.2.1")).toBe("too-old");
    expect(classifyPiVersion("1.3.0")).toBe("too-old");
    expect(classifyPiVersion("1.3.1")).toBe("too-old");
    expect(classifyPiVersion("1.4.0")).toBe("too-old");
    expect(classifyPiVersion("1.5.0")).toBe("too-old");
    expect(classifyPiVersion("1.5.1")).toBe("audited");
    expect(classifyPiVersion("1.5.2")).toBe("audited");
    expect(classifyPiVersion("1.5.3")).toBe("forward-compatible");
    expect(classifyPiVersion("1.99.0")).toBe("forward-compatible");
    expect(classifyPiVersion("1.0.0-rc.1")).toBe("prerelease");
    expect(classifyPiVersion("2.0.0")).toBe("major-version");

    expect(isPiVersionLoadable("0.99.2")).toBe(false);
    expect(isPiVersionLoadable("1.0.0")).toBe(false);
    expect(isPiVersionLoadable("1.0.0-rc.1")).toBe(false);
    expect(isPiVersionLoadable("1.5.0")).toBe(false);
    expect(isPiVersionLoadable("1.5.1")).toBe(true);
    expect(isPiVersionLoadable("1.5.2")).toBe(true);
    expect(isPiVersionLoadable("2.0.0")).toBe(false);
  });
});

describe("requirePiVersion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts the installed audited or forward-compatible runtime", () => {
    const installed = getInstalledPiVersion();
    expect(installed).toBeDefined();
    const compatibility = classifyPiVersion(installed!);
    expect(["audited", "forward-compatible"]).toContain(compatibility);

    // Preserve the process-wide forward-warning latch for the explicit
    // once-only test below when the nightly `latest` overlay is ahead.
    if (compatibility === "audited") {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(requirePiVersion(null, "sf-pi-compat-test", MIN_PI_VERSION)).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } else {
      expect(isPiVersionLoadable(installed!)).toBe(true);
    }
  });

  it("returns false and logs once when below the floor", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Use a floor far above any plausible installed version so the gate
    // definitely trips, regardless of which pi version the dev has locally.
    const unreachable = "9999.0.0";
    // First call: logs.
    expect(requirePiVersion(null, "sf-pi-compat-once", unreachable)).toBe(false);
    // Second call with the same extension name: no second log.
    expect(requirePiVersion(null, "sf-pi-compat-once", unreachable)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/sf-pi-compat-once/);
    expect(warn.mock.calls[0][0]).toMatch(/9999\.0\.0/);
    expect(warn.mock.calls[0][0]).toMatch(/Pi 1\.5\.2/);
    expect(warn.mock.calls[0][0]).toMatch(/\/sf-pi doctor runtime/);
  });

  it("older Pi degrades by skipping the extension instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ok = requirePiVersion({ any: "shape" }, "sf-old-pi-skip", "9999.0.0");

    expect(ok).toBe(false);
    expect(warn.mock.calls[0][0]).toContain('Skipping "sf-old-pi-skip"');
    expect(warn.mock.calls[0][0]).toContain("Use Pi 1.5.2");
  });

  it("warns once across isolated module graphs for a newer stable Pi", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stateKey = Symbol.for("sf-pi.pi-compat.forward-warning");
    const processState = globalThis as typeof globalThis & Record<symbol, unknown>;
    delete processState[stateKey];

    const first = await import("../pi-compat.ts");
    const installed = first.getInstalledPiVersion();
    expect(installed).toBeDefined();
    expect(first.requirePiVersion(null, "sf-forward-a", "0.0.0", installed!, "2.0.0")).toBe(true);

    vi.resetModules();
    const second = await import("../pi-compat.ts");
    expect(second.requirePiVersion(null, "sf-forward-b", "0.0.0", installed!, "2.0.0")).toBe(true);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("forward-compatibility mode");
    expect(warn.mock.calls[0][0]).not.toContain("Skipping");
    delete processState[stateKey];
  });

  it("still blocks a Pi major version pending review", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const installed = getInstalledPiVersion();
    expect(installed).toBeDefined();

    const ok = requirePiVersion(null, "sf-major-pi-skip", "0.0.0", "0.0.0", installed!);

    expect(ok).toBe(false);
    expect(warn.mock.calls[0][0]).toContain('Skipping "sf-major-pi-skip"');
    expect(warn.mock.calls[0][0]).toContain(`stable pi-coding-agent >= 0.0.0 and < ${installed}`);
    expect(warn.mock.calls[0][0]).toContain("/sf-pi doctor runtime");
  });
});
