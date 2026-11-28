/* SPDX-License-Identifier: Apache-2.0 */
/** Visible Browser Evidence rendering for SF Browser command output. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type KeyEvent, UiNode } from "@oh-my-pi/pi-tui";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import { nativeUi } from "../../../lib/common/ui-rows.ts";
import { evidenceImage } from "./evidence-image.ts";

export interface SplitEvidenceContent {
  text: string;
  image?: ImageContent;
}

export function splitEvidenceContent(
  content: Array<TextContent | ImageContent>,
): SplitEvidenceContent {
  const text = content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  const image = content.find((part): part is ImageContent => part.type === "image");
  return { text, image };
}

export async function openEvidencePanel(
  ctx: ExtensionCommandContext,
  options: { title: string; text: string; image: ImageContent },
): Promise<void> {
  await nativeUi(ctx.ui).custom<void>(
    (ui, _theme, _keybindings, done) => {
      const label = (t: string, s?: string) => new UiNode("text", { spans: [{ t, s }] });
      const { image, text, title } = options;
      const previewRows = () => {
        const { columns, rows } = ui.size();
        // Reserve space for the title, evidence details, preview label, hint, and gaps.
        return Math.max(1, Math.min(32, rows - wrap(text, Math.max(1, columns)).length - 6));
      };
      return new UiNode("col", {
        gap: "xs",
        onKey: (key: KeyEvent) => {
          if (
            key.kind === "release" ||
            (key.id !== "escape" && key.id !== "enter" && key.id !== "q")
          )
            return false;
          done();
          return true;
        },
        children: [
          label(`📸 ${title}`, "success strong"),
          label(text),
          new UiNode("col", {
            children: [
              label("Screenshot preview", "toolTitle strong"),
              evidenceImage(Buffer.from(image.data, "base64"), image.mimeType, 100, previewRows),
            ],
          }),
          label("Enter/Esc/q to close", "dim"),
        ],
      });
    },
    { overlay: true },
  );
}
