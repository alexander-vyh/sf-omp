/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { resolveSfPiPackageRoot, resolveSfPiPackageRootPath } from "../sf-pi-package-root.ts";

describe("resolveSfPiPackageRoot", () => {
  it("walks up from the calling module to the checkout root", () => {
    const result = resolveSfPiPackageRoot({ from: import.meta.url });

    expect(result).toMatchObject({ packageRoot: process.cwd(), source: "module-walk" });
    expect(resolveSfPiPackageRootPath({ from: import.meta.url })).toBe(process.cwd());
  });

  it("reports missing when no ancestor holds package.json and catalog/", () => {
    expect(resolveSfPiPackageRoot({ from: "file:///sf-pi-no-root/a/b/c.ts" })).toEqual({
      source: "missing",
    });
  });
});
