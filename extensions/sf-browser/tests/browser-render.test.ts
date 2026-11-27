/* SPDX-License-Identifier: Apache-2.0 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { getBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { describe, expect, it } from "vitest";
import {
  renderBrowserToolCall,
  renderBrowserToolResult,
  SF_BROWSER_IMAGE_WIDTH_CELLS,
} from "../lib/browser-render.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_color: string, text: string) => text,
};

function render(node: UiNode): string {
  return renderBlock(node, 120, { theme: currentTheme() }).rows.join("\n");
}

describe("SF Browser tool cards", () => {
  it("renders private browser thumbnails 50% wider than Pi's 60-cell default", () => {
    expect(SF_BROWSER_IMAGE_WIDTH_CELLS).toBe(90);
  });

  it("renders a concise navigation intent and evidence-first result card", () => {
    const args = {
      target_org: "ExampleDev",
      target: { type: "setup", destination: "session-settings" },
      purpose: "Review timeout controls",
    };
    const call = render(renderBrowserToolCall("sf_browser_open_org", args, theme));
    const result = render(
      renderBrowserToolResult(
        "sf_browser_open_org",
        {
          content: [{ type: "text", text: "Opened Salesforce org in agent-browser." }],
          details: {
            ok: true,
            targetOrg: "ExampleDev",
            path: "/lightning/setup/SecuritySession/home",
            openMethod: "same-org-direct",
            durationText: "420ms",
            evidence: {
              id: 12,
              label: "open-session-settings",
              path: "/tmp/open-session-settings.png",
              thumbnailPath: "/tmp/open-session-settings.thumb.png",
            },
          },
        },
        { expanded: false, isPartial: false },
        theme,
        args,
      ),
    );

    expect(call).toContain("🧭 SF Browser");
    expect(call).toContain("Open · Session Settings · ExampleDev");
    expect(result).toContain("🧭 Open Setup · Session Settings");
    expect(result).toContain("✓ success");
    expect(result).toContain("same-org direct");
    expect(result).toContain("420ms");
    expect(result).toContain("open-session-settings.png");
    expect(result).toContain("Snapshot current controls before acting");
    expect(result.split("\n").length).toBeLessThanOrEqual(14);
  });

  it("renders the observed Salesforce page instead of a generic snapshot summary", () => {
    const rendered = render(
      renderBrowserToolResult(
        "sf_browser_snapshot",
        {
          content: [
            {
              type: "text",
              text: [
                "🧭 Snapshot summary",
                "",
                "📍 Page:",
                '- Heading: - heading "External Client App Manager" [level=1, ref=e1]',
                "",
                "🎯 Primary actions:",
                '- - button "New External Client App" [ref=e2]',
              ].join("\n"),
            },
          ],
          details: { ok: true, durationText: "380ms" },
        },
        { expanded: false, isPartial: false },
        theme,
        { focus: ["External Client App Manager", "Nothing to show yet"] },
      ),
    );

    expect(rendered).toContain("Observe · External Client App Manager");
    expect(rendered).toContain("External Client App Manager is ready for ref-based interaction.");
    expect(rendered).not.toContain("summary    🧭 Snapshot summary");
  });

  it("renders an explicit running state for partial results", () => {
    const rendered = render(
      renderBrowserToolResult(
        "sf_browser_snapshot",
        { content: [], details: { phase: "Capturing controls" } },
        { expanded: false, isPartial: true },
        theme,
        { focus: ["Agentforce"] },
      ),
    );

    expect(rendered).toContain("⏳ SF Browser · Capturing controls");
  });

  it("draws attached evidence as a native image in the terminal tool view", () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=";
    const node = renderBrowserToolResult(
      "sf_browser_capture_evidence",
      { content: [{ type: "image", data: png, mimeType: "image/png" }] },
      {},
      theme,
    );

    const previews = node.children().filter((child) => child.kind === "image");
    expect(previews).toHaveLength(1);
    expect(previews[0]?.props()).toMatchObject({ w: 1, h: 1, max: { w: "90ch" } });
    const blob = (previews[0] as UiNode<"image">).props().blob!;
    expect(getBlob(blob)?.bytes).toEqual(Buffer.from(png, "base64"));
  });

  it("keeps the evidence card but skips the inline image when disabled", () => {
    const node = renderBrowserToolResult(
      "sf_browser_capture_evidence",
      {
        content: [{ type: "image", data: "not-decoded", mimeType: "image/png" }],
        details: { ok: true },
      },
      {},
      theme,
      undefined,
      false,
    );

    expect(node.kind).toBe("ansi");
    expect(render(node)).toContain("success");
  });
});
