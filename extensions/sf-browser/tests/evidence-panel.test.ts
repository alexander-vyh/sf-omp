/* SPDX-License-Identifier: Apache-2.0 */
/** Tests for visible Browser Evidence command output helpers. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { openEvidencePanel, splitEvidenceContent } from "../lib/evidence-panel.ts";

describe("evidence panel helpers", () => {
  it("splits text and first image content for visible evidence output", () => {
    const result = splitEvidenceContent([
      { type: "text", text: "Captured Browser Evidence #1." },
      { type: "image", data: "abc123", mimeType: "image/jpeg" },
      { type: "text", text: "Path: /tmp/evidence.png" },
    ]);

    expect(result.text).toBe("Captured Browser Evidence #1.\nPath: /tmp/evidence.png");
    expect(result.image).toEqual({ type: "image", data: "abc123", mimeType: "image/jpeg" });
  });

  it("returns trimmed text without an image when evidence is artifact-only", () => {
    const result = splitEvidenceContent([{ type: "text", text: "  Path: /tmp/evidence.png  " }]);

    expect(result.text).toBe("Path: /tmp/evidence.png");
    expect(result.image).toBeUndefined();
  });

  it("mounts a native, height-bounded preview and closes on Escape", async () => {
    const done = vi.fn();
    const custom = vi.fn(
      async (
        factory: (
          ui: { size: () => { columns: number; rows: number } },
          theme: undefined,
          keybindings: undefined,
          finish: () => void,
        ) => UiNode,
      ) => {
        const panel = factory(
          { size: () => ({ columns: 80, rows: 24 }) },
          undefined,
          undefined,
          done,
        );
        const preview = panel
          .children()
          .flatMap((child) => child.children())
          .find((child) => child.kind === "image");
        expect(preview?.props()).toMatchObject({ w: 1, h: 1, max: { w: "100ch", h: "16lines" } });
        expect(panel.handlers.onKey?.({ kind: "release", id: "escape", raw: "\x1b" })).toBe(false);
        expect(panel.handlers.onKey?.({ kind: "press", id: "escape", raw: "\x1b" })).toBe(true);
      },
    );
    const ctx = { ui: { custom } } as unknown as ExtensionCommandContext;
    await openEvidencePanel(ctx, {
      title: "SF Browser evidence",
      text: "Screenshot captured.\nPath: /tmp/evidence.png",
      image: {
        type: "image",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=",
        mimeType: "image/png",
      },
    });
    expect(custom).toHaveBeenCalledWith(expect.any(Function), { overlay: true });
    expect(done).toHaveBeenCalledTimes(1);
  });
});
