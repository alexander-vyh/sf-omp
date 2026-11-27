/* SPDX-License-Identifier: Apache-2.0 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema as OmpSchema } from "@oh-my-pi/pi-ai";
import type {
  ExtensionRender,
  ExtensionTheme,
  ToolDefinition as OmpToolDefinition,
  ToolRenderResultOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Static, TSchema } from "typebox";

type OmpToolResult<TDetails> = Parameters<
  NonNullable<OmpToolDefinition<OmpSchema, TDetails>["renderResult"]>
>[0];

/** Preserve the SF Pi schema and execution types while using OMP's renderer contract. */
export type NativeUiTool<TParams extends TSchema, TDetails> = Omit<
  ToolDefinition<TParams, TDetails>,
  "renderCall" | "renderResult"
> & {
  renderCall?: (
    args: Static<TParams>,
    options: ToolRenderResultOptions,
    theme: ExtensionTheme,
  ) => ExtensionRender | undefined;
  renderResult?: (
    result: OmpToolResult<TDetails>,
    options: ToolRenderResultOptions,
    theme: ExtensionTheme,
    args?: Static<TParams>,
  ) => ExtensionRender | undefined;
};

export function registerNativeUiTool<TParams extends TSchema, TDetails>(
  pi: Pick<ExtensionAPI, "registerTool">,
  definition: NativeUiTool<TParams, TDetails>,
): void {
  // The runtime is OMP. Only the inherited static registerTool declaration describes Pi renderers.
  pi.registerTool(definition as unknown as ToolDefinition<TParams, TDetails>);
}
