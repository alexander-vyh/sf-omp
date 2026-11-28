/* SPDX-License-Identifier: Apache-2.0 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openEvalStudio } from "../lib/eval-studio/open.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Eval Studio public open seam", () => {
  it("mounts the native fullscreen custom overlay and gets its terminal size from the host", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "eval-studio-open-"));
    dirs.push(cwd);
    await writeFile(path.join(cwd, "sfdx-project.json"), "{}");
    const signal = new AbortController().signal;
    const size = vi.fn(() => ({ columns: 100, rows: 40 }));
    const custom = vi.fn(async (factory, _options) => {
      return await new Promise((resolve) => {
        const component = factory(
          { size, requestRender: vi.fn() },
          { fg: (_name: string, value: string) => value, bold: (value: string) => value },
          {},
          resolve,
        );
        expect(component.render(100).join("\n")).toContain("Agent Script Eval Studio");
        expect(size).toHaveBeenCalled();
        component.handleInput("q");
      });
    });
    await openEvalStudio(
      { appendEntry: vi.fn() } as never,
      {
        cwd,
        mode: "tui",
        hasUI: true,
        signal,
        ui: { custom },
      } as never,
    );
    expect(custom).toHaveBeenCalledWith(expect.any(Function), {
      overlay: true,
      fullscreen: true,
      signal,
    });
  });

  it("propagates a native custom UI failure", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "eval-studio-open-"));
    dirs.push(cwd);
    await writeFile(path.join(cwd, "sfdx-project.json"), "{}");
    const error = new Error("overlay mount failed");
    await expect(
      openEvalStudio(
        { appendEntry: vi.fn() } as never,
        {
          cwd,
          mode: "tui",
          hasUI: true,
          ui: { custom: vi.fn().mockRejectedValue(error) },
        } as never,
      ),
    ).rejects.toBe(error);
  });

  it("treats native signal cancellation as closing the Studio", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "eval-studio-open-"));
    dirs.push(cwd);
    await writeFile(path.join(cwd, "sfdx-project.json"), "{}");
    const controller = new AbortController();
    const custom = vi.fn(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(
      openEvalStudio(
        { appendEntry: vi.fn() } as never,
        {
          cwd,
          mode: "tui",
          hasUI: true,
          signal: controller.signal,
          ui: { custom },
        } as never,
      ),
    ).resolves.toBeUndefined();
  });

  it("returns a bounded local inventory in non-TUI mode without mounting custom UI", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "eval-studio-open-"));
    dirs.push(cwd);
    await writeFile(path.join(cwd, "sfdx-project.json"), "{}");
    await mkdir(path.join(cwd, "tests", "agentforce"), { recursive: true });
    await writeFile(
      path.join(cwd, "tests", "agentforce", "Demo.eval.json"),
      JSON.stringify({ tests: [] }),
    );
    const appendEntry = vi.fn();
    const custom = vi.fn();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await openEvalStudio(
      { appendEntry } as never,
      {
        cwd,
        mode: "print",
        hasUI: false,
        ui: { custom },
      } as never,
    );
    expect(custom).not.toHaveBeenCalled();
    expect(appendEntry).toHaveBeenCalledWith(
      "sf-agentscript-eval-studio-output",
      expect.objectContaining({ body: expect.stringContaining("Suites: 1") }),
    );
    info.mockRestore();
  });
});
