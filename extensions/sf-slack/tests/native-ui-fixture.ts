/* SPDX-License-Identifier: Apache-2.0 */
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { Overlays } from "@oh-my-pi/pi-coding-agent/ui/shell/overlays";
import { UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";

export interface NativeTestUi {
  composer: UiNode<"text">;
  controller: ExtensionUiController;
  overlays: Overlays;
  terminal: TestTerminal;
  ui: ExtensionUIContext;
  dispose(): void;
}

/** Use OMP's dialog controller, overlay stack, and terminal backend without starting a session. */
export async function createNativeTestUi(): Promise<NativeTestUi> {
  const size = { columns: 100, rows: 30 };
  const composer = new UiNode("text", { text: "Test composer" });
  const overlays = new Overlays({
    focused: () => terminal.surface.focused(),
    focus: (node) => terminal.surface.focus(node),
    fallback: () => composer,
  });
  const terminal: TestTerminal = createTestTerminal(
    () => ({ dock: composer, layer: overlays.nodes }),
    size,
  );
  terminal.focus(composer);
  const controller = new ExtensionUiController({
    shell: { size: () => size, native: () => false, overlays },
    session: {},
    keybindings: KeybindingsManager.inMemory(),
    setToolUIContext() {},
    syncComposerShape() {},
    syncExtensionLinks() {},
    closeLinkBrowser() {},
    showEditorAreaDialog: overlays.show.bind(overlays),
  } as unknown as ConstructorParameters<typeof ExtensionUiController>[0]);
  await controller.initHooksAndCustomTools();
  const ui = controller.getToolUIContext();
  if (!ui) throw new Error("OMP did not initialize the extension UI");
  return {
    composer,
    controller,
    overlays,
    terminal,
    ui,
    dispose() {
      overlays.closeAll();
      terminal.dispose();
    },
  };
}
