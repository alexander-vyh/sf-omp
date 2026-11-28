/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Runtime-proof probe: OMP's `--mode json` stream omits appended session
 * entries, so write the session's entries to SF_OMP_PROBE_ENTRIES at shutdown.
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

export default function sessionEntriesProbe(pi: ExtensionAPI): void {
  pi.on("session_shutdown", (_event, ctx) => {
    const target = process.env.SF_OMP_PROBE_ENTRIES;
    if (target) writeFileSync(target, JSON.stringify(ctx.sessionManager.getEntries()));
  });
}
