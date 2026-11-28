/* SPDX-License-Identifier: Apache-2.0 */
import type {
  ExtensionRows,
  ExtensionTheme,
  ExtensionWidgetContent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

/** Mount an extension widget in the headless smoke's capture UI. */
export function mountWidgetRows(
  content: Exclude<ExtensionWidgetContent, undefined>,
  theme: ExtensionTheme,
  columns: number,
): ExtensionRows {
  if (typeof content !== "function") return { render: () => content };
  const view = content(
    {
      size: () => ({ columns, rows: 40 }),
      requestRender() {},
      suspend: (run) => run(),
    },
    theme,
  );
  if (
    !view ||
    typeof view !== "object" ||
    !("render" in view) ||
    typeof view.render !== "function"
  ) {
    throw new Error("The extension widget did not return a width-aware rows view.");
  }
  return view;
}
