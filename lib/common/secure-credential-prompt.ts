/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Session-bound masked credential entry for SF Pi provider authentication.
 *
 * OMP owns `/login` orchestration and credential persistence. This supplies
 * fixed-length masking when a provider interaction needs the session prompt.
 */
import type { ApiKeyCredential, AuthInteraction } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionRows,
  ExtensionTheme,
  ExtensionUiHost,
  ExtensionUIContext as NativeUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import { hostMasksSecretPrompts } from "./auth-only-provider.ts";
import { decodeRowKey, nativeUi } from "./ui-rows.ts";

const CANCELLED_MESSAGE = "Login cancelled";
const UNAVAILABLE_MESSAGE = "Secure credential entry is only available in interactive TUI mode.";
const MASK = "••••••••";
const DEFAULT_DESCRIPTION = "The submitted value is masked and is not added to the session.";
const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;
const SS3 = `${ESC}O`;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function stripTerminalControls(data: string): string {
  let output = "";
  for (let i = 0; i < data.length; i++) {
    const nextIndex = consumeTerminalControl(data, i);
    if (nextIndex !== i) {
      i = nextIndex - 1;
      continue;
    }
    const code = data.charCodeAt(i);
    if (code < 32 || (code >= 127 && code <= 159)) continue;
    output += data[i] ?? "";
  }
  return output;
}

function consumeTerminalControl(data: string, index: number): number {
  if (data.startsWith(CSI, index)) {
    for (let i = index + CSI.length; i < data.length; i++) {
      const code = data.charCodeAt(i);
      if (code >= 64 && code <= 126) return i + 1;
    }
    return data.length;
  }
  if (data.startsWith(SS3, index) && /[ABCD]/.test(data[index + 2] ?? "")) return index + 3;
  return index;
}

export interface SecureCredentialPromptOptions {
  title: string;
  description?: string;
}

export class MaskedCredentialInput implements ExtensionRows {
  private value = "";
  private settled = false;

  constructor(
    private readonly ui: ExtensionUiHost,
    private readonly theme: ExtensionTheme,
    private readonly done: (value: string | undefined) => void,
    private readonly options: SecureCredentialPromptOptions = { title: "Secure credential" },
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const maskedValue = this.value ? MASK : "";
    const end = this.theme.fg("border", this.settled ? "]" : this.theme.inverse("]"));

    return [
      truncate(this.theme.fg("accent", this.theme.bold(this.options.title)), safeWidth),
      truncate(this.theme.fg("muted", this.options.description ?? DEFAULT_DESCRIPTION), safeWidth),
      truncate(
        `${this.theme.fg("border", "[")}${this.theme.fg("text", maskedValue)}${end}`,
        safeWidth,
      ),
      truncate(this.theme.fg("dim", "Enter saves • Esc cancels • Backspace edits"), safeWidth),
    ];
  }

  handleInput(data: string): void {
    if (this.settled) return;

    const key = decodeRowKey(data);
    if (key?.kind === "release") return;
    if (key?.id === "escape") {
      this.cancel();
      return;
    }

    if (key?.id === "enter") {
      if (!this.value) return;
      const submitted = this.value;
      this.value = "";
      this.settled = true;
      this.done(submitted);
      return;
    }

    if (key?.id === "backspace") {
      const last = graphemeSegmenter.segment(this.value).containing(this.value.length - 1);
      this.value = last ? this.value.slice(0, last.index) : "";
      this.ui.requestRender();
      return;
    }

    // Paste arrives bracketed; filter terminal controls even if pasted bytes
    // look like a key. Orphaned CSI fragments should not become credential text.
    let text = key ? key.text : data;
    if (key && text === undefined) {
      // A Kitty key can name a supplementary character without associated text.
      const id = key.id.startsWith("shift+") ? key.id.slice(6) : key.id;
      if (/^[\u{10000}-\u{10ffff}]$/u.test(id)) text = id;
    }
    if (!text || (!key && /^\[(?:\d+(?:;\d+)*)?[A-Za-z~]$/.test(text))) return;
    const clean = stripTerminalControls(text);
    if (!clean) return;
    this.value += clean;
    this.ui.requestRender();
  }

  cancel(): void {
    if (this.settled) return;
    this.value = "";
    this.settled = true;
    this.done(undefined);
  }

  dispose(): void {
    this.value = "";
    this.settled = true;
  }
}

type ExtensionMode = ExtensionContext["mode"];

export interface SecureCredentialPromptBridge {
  /** Prompt title, reused as the host-native secret prompt message. */
  readonly title?: string;
  bind(ui: ExtensionUIContext, mode: ExtensionMode): void;
  clear(): void;
  prompt(signal?: AbortSignal): Promise<string>;
}

export async function loginWithSecureCredentialPrompt(
  bridge: SecureCredentialPromptBridge,
  interaction: AuthInteraction,
): Promise<ApiKeyCredential> {
  // OMP's login dialog masks secret prompts itself and owns focus while open,
  // so a second custom component would compete with it.
  if (hostMasksSecretPrompts(interaction)) {
    const key = await interaction.prompt({
      type: "secret",
      message: bridge.title ?? "Secure credential",
    });
    return { type: "api_key", key };
  }
  return {
    type: "api_key",
    key: await bridge.prompt(interaction.signal),
  };
}

export function createSecureCredentialPromptBridge(
  options: SecureCredentialPromptOptions = { title: "Secure credential" },
): SecureCredentialPromptBridge {
  let ui: NativeUIContext | undefined;
  let activePrompt: AbortController | undefined;

  const cancelActivePrompt = () => {
    const current = activePrompt;
    activePrompt = undefined;
    current?.abort(new Error(CANCELLED_MESSAGE));
  };

  return {
    title: options.title,
    bind(sessionUi, mode) {
      ui = mode === "tui" ? nativeUi(sessionUi) : undefined;
      cancelActivePrompt();
    },

    clear() {
      ui = undefined;
      cancelActivePrompt();
    },

    async prompt(signal) {
      if (!ui) {
        throw new Error(UNAVAILABLE_MESSAGE);
      }
      if (signal?.aborted) {
        throw new Error(CANCELLED_MESSAGE);
      }
      if (activePrompt) {
        throw new Error("Credential entry is already active.");
      }

      const controller = new AbortController();
      activePrompt = controller;
      const onAbort = () => controller.abort(new Error(CANCELLED_MESSAGE));
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await ui.custom<string | undefined>(
          (host, theme, _keybindings, done) =>
            new MaskedCredentialInput(host, theme, done, options),
          { signal: controller.signal },
        );

        if (controller.signal.aborted || !result) {
          throw new Error(CANCELLED_MESSAGE);
        }
        return result;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (activePrompt === controller) activePrompt = undefined;
      }
    },
  };
}
