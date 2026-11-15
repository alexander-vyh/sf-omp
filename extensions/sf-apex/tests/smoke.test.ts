/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, vi } from "vitest";

describe("sf-apex", () => {
  it("registers flat slash-command completions", async () => {
    const mod = await import("../index.ts");
    const pi = { on: vi.fn(), registerCommand: vi.fn() };

    mod.default(pi as never);

    const command = pi.registerCommand.mock.calls.find(([name]) => name === "sf-apex")?.[1];
    expect(command?.getArgumentCompletions?.("st")?.map((item) => item.value)).toEqual(["status"]);
    expect(command?.getArgumentCompletions?.("status h")).toBeNull();
  });
});
