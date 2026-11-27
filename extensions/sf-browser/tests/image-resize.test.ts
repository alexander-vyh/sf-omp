/* SPDX-License-Identifier: Apache-2.0 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDimensionNote, resizeImage } from "../lib/image-resize.ts";

const { ompResize } = vi.hoisted(() => ({ ompResize: vi.fn() }));

vi.mock("@oh-my-pi/pi-coding-agent/utils/image-resize", () => ({ resizeImage: ompResize }));

describe("image-resize OMP host adapter", () => {
  afterEach(() => ompResize.mockReset());

  it("keeps screenshots within the requested size without upscaling or WebP output", async () => {
    ompResize.mockResolvedValue({
      data: "AAAA",
      mimeType: "image/jpeg",
      originalWidth: 3000,
      originalHeight: 2000,
      width: 1440,
      height: 960,
      wasResized: true,
      buffer: new Uint8Array(),
    });
    const bytes = new Uint8Array([1, 2, 3]);

    const result = await resizeImage(bytes, "image/png", { maxWidth: 1440, maxHeight: 1000 });

    expect(ompResize).toHaveBeenCalledWith(
      { bytes, mimeType: "image/png" },
      { maxWidth: 1440, maxHeight: 1000, minDimension: 1, excludeWebP: true },
    );
    expect(result).toEqual({
      data: "AAAA",
      mimeType: "image/jpeg",
      originalWidth: 3000,
      originalHeight: 2000,
      width: 1440,
      height: 960,
      wasResized: true,
    });
    expect(formatDimensionNote(result!)).toBe(
      "[Image: original 3000x2000, displayed at 1440x960. Multiply coordinates by 2.08 to map to original image.]",
    );
  });

  it("resolves null when OMP cannot decode the image", async () => {
    ompResize.mockResolvedValue({ decodeFailed: true, wasResized: false });

    await expect(resizeImage(new Uint8Array([0]), "image/png")).resolves.toBeNull();
  });

  it("omits the dimension note for unresized images", () => {
    expect(
      formatDimensionNote({
        data: "",
        mimeType: "image/png",
        originalWidth: 50,
        originalHeight: 40,
        width: 50,
        height: 40,
        wasResized: false,
      }),
    ).toBeUndefined();
  });
});
