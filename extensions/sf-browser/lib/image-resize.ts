/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Host-adaptive screenshot thumbnail resizing.
 *
 * Pi exports `resizeImage(bytes, mimeType, options)` and `formatDimensionNote`
 * from its coding-agent package. OMP's legacy Pi shim does not re-export them,
 * so a named import fails the whole extension load there. OMP ships the same
 * capability as `@oh-my-pi/pi-coding-agent/utils/image-resize` with a different
 * call shape; this module adapts it to Pi's contract (PNG/JPEG output, no
 * upscaling, `null` on decode failure).
 */
import * as PiRuntime from "@earendil-works/pi-coding-agent";

export interface ImageResizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  maxBytes?: number;
  jpegQuality?: number;
}

export interface ResizedImage {
  /** Base64-encoded image bytes. */
  data: string;
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
}

type PiResize = (
  inputBytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
) => Promise<ResizedImage | null>;
type PiDimensionNote = (result: ResizedImage) => string | undefined;

interface OmpResizedImage extends ResizedImage {
  decodeFailed?: boolean;
}
interface OmpImageResizeModule {
  resizeImage(
    input: { bytes: Uint8Array; mimeType?: string },
    options?: ImageResizeOptions & { minDimension?: number; excludeWebP?: boolean },
  ): Promise<OmpResizedImage>;
  formatDimensionNote(result: ResizedImage): string | undefined;
}

const piRuntime = PiRuntime as { resizeImage?: unknown; formatDimensionNote?: unknown };
let ompModule: Promise<OmpImageResizeModule> | undefined;

/** Resize to fit the bounds; resolves `null` when the image cannot be decoded. */
export async function resizeImage(
  inputBytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
  if (typeof piRuntime.resizeImage === "function") {
    return (piRuntime.resizeImage as PiResize)(inputBytes, mimeType, options);
  }
  // Dynamic: this OMP-only module needs Bun.Image and must never load on the Pi host.
  ompModule ??=
    import("@oh-my-pi/pi-coding-agent/utils/image-resize") as Promise<OmpImageResizeModule>;
  const omp = await ompModule;
  // Pi never upscales and only emits PNG/JPEG; thumbnail paths depend on that.
  const resized = await omp.resizeImage(
    { bytes: inputBytes, mimeType },
    { ...options, minDimension: 1, excludeWebP: true },
  );
  if (resized.decodeFailed) return null;
  return {
    data: resized.data,
    mimeType: resized.mimeType,
    originalWidth: resized.originalWidth,
    originalHeight: resized.originalHeight,
    width: resized.width,
    height: resized.height,
    wasResized: resized.wasResized,
  };
}

/** Coordinate-mapping note for a resized image; `undefined` when not resized. */
export function formatDimensionNote(result: ResizedImage): string | undefined {
  if (typeof piRuntime.formatDimensionNote === "function") {
    return (piRuntime.formatDimensionNote as PiDimensionNote)(result);
  }
  if (!result.wasResized) return undefined;
  const scale = result.originalWidth / result.width;
  return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
