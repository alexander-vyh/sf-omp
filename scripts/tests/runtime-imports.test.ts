/* SPDX-License-Identifier: Apache-2.0 */
/** Behavior Proofs for the runtime import check (git installs omit dev and peer deps). */
import { describe, expect, it } from "vitest";
import {
  HOST_ALIASES,
  isAllowed,
  packageName,
  runtimeSpecifiers,
} from "../check-runtime-imports.mjs";

const PROD = new Set(["yaml", "@salesforce/core"]);
const specs = (text: string) =>
  runtimeSpecifiers(text).map((s: { specifier: string }) => s.specifier);

describe("runtime import check", () => {
  it("allows built-ins, production deps (and subpaths), and exact OMP loader aliases", () => {
    expect(isAllowed("node:fs", PROD)).toBe(true);
    expect(isAllowed("path", PROD)).toBe(true);
    expect(isAllowed("yaml", PROD)).toBe(true);
    expect(isAllowed("@salesforce/core/lib/org", PROD)).toBe(true);
    expect(isAllowed("typebox", PROD)).toBe(true);
    expect(isAllowed("typebox/value")).toBe(true);
    expect(isAllowed("@earendil-works/pi-ai/compat", PROD)).toBe(true);
    expect(isAllowed("@oh-my-pi/pi-tui/text/width", PROD)).toBe(true);
    expect(isAllowed("@oh-my-pi/pi-coding-agent/config/keybindings/key-id", PROD)).toBe(true);
    expect(isAllowed("@oh-my-pi/pi-coding-agent/tools/file-mutation-queue", PROD)).toBe(true);
    expect(isAllowed("@oh-my-pi/pi-coding-agent/utils/clipboard", PROD)).toBe(true);
    expect(isAllowed("@oh-my-pi/pi-tui/native/blobs", PROD)).toBe(true);
  });

  it("rejects unaliased host subpaths and dev-only packages", () => {
    expect(isAllowed("typebox/schema", PROD)).toBe(false);
    expect(isAllowed("typebox/value", PROD)).toBe(false);
    expect(isAllowed("@oh-my-pi/pi-tui/missing-export", PROD)).toBe(false);
    expect(isAllowed("vitest", PROD)).toBe(false);
    expect(isAllowed("typescript", PROD)).toBe(false);
    expect(HOST_ALIASES.has("typebox/schema")).toBe(false);
  });

  it("rejects legacy TUI imports even when the dependency exists", () => {
    const prodWithLegacy = new Set([...PROD, "@earendil-works/pi-tui"]);
    expect(isAllowed("@earendil-works/pi-tui", prodWithLegacy)).toBe(false);
    expect(isAllowed("@earendil-works/pi-tui/keybindings", prodWithLegacy)).toBe(false);
    expect(isAllowed("@mariozechner/pi-tui", PROD)).toBe(false);
  });

  it("finds static, re-export, dynamic import, and require specifiers from the AST", () => {
    const text = [
      'import { a } from "yaml";',
      'import * as S from "typebox/schema";',
      'export { b } from "@scope/pkg/sub";',
      'const m = await import("dyn-pkg");',
      'const r = require("req-pkg");',
      'import "side-effect";',
      'import { x } from "./local.ts";',
    ].join("\n");
    expect(specs(text)).toEqual([
      "yaml",
      "typebox/schema",
      "@scope/pkg/sub",
      "dyn-pkg",
      "req-pkg",
      "side-effect",
    ]);
  });

  it("ignores type-only imports and the word import inside strings or templates", () => {
    const text = [
      'import type { T } from "type-only";',
      'import { type A, type B } from "named-type-only";',
      "const s = `await import('tldraw')`;",
      'const msg = "imports \\"something\\"";',
      "// import x from 'commented'",
    ].join("\n");
    expect(specs(text)).toEqual([]);
  });

  it("honors the explicit allow comment for intentional optional imports", () => {
    const text = '// sf-pi-allow-runtime-import\nconst o = await import("optional-pkg");';
    expect(specs(text)).toEqual([]);
  });

  it("derives package names for scoped and unscoped specifiers", () => {
    expect(packageName("@salesforce/core/lib/org")).toBe("@salesforce/core");
    expect(packageName("yaml/util")).toBe("yaml");
  });
});
