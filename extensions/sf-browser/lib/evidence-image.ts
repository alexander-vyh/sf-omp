/* SPDX-License-Identifier: Apache-2.0 */
import { pathToFileURL } from "node:url";
import { readImageHeaderDimensions } from "@oh-my-pi/pi-coding-agent/utils/image-resize";
import { UiNode } from "@oh-my-pi/pi-tui";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";

export function evidenceImage(
  bytes: Uint8Array,
  mimeType: string,
  columns: number,
  rows?: () => number,
  filePath?: string,
): UiNode<"image"> {
  const size = readImageHeaderDimensions(bytes);
  return new UiNode("image", {
    blob: registerBlob(bytes, mimeType),
    w: size?.width,
    h: size?.height,
    alt: `[Image: ${mimeType}${size ? ` ${size.width}x${size.height}` : ""}]`,
    max: () => ({ w: `${columns}ch`, h: rows ? `${rows()}lines` : undefined }),
    href: filePath ? pathToFileURL(filePath).href : undefined,
    actions: filePath ? { menu: ["open"] } : undefined,
  });
}
