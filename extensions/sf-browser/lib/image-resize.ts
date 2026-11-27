/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Resize native OMP screenshot thumbnails without upscaling or WebP output.
 */
import { resizeImage as resizeOmpImage } from "@oh-my-pi/pi-coding-agent/utils/image-resize";

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

/** Resize to fit the bounds; resolves `null` when the image cannot be decoded. */
export async function resizeImage(
  inputBytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
  const resized = await resizeOmpImage(
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
  if (!result.wasResized) return undefined;
  const scale = result.originalWidth / result.width;
  return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
