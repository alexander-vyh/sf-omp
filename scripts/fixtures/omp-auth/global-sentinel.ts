/* SPDX-License-Identifier: Apache-2.0 */
import { writeFileSync } from "node:fs";

// Both module evaluation and factory loading must stay outside the local host.
const marker = process.env.SF_OMP_AUTH_SENTINEL_MARKER;
if (marker) writeFileSync(marker, "global-extension-loaded\n", { mode: 0o600 });
export default function globalSentinel(): void {
  if (marker) writeFileSync(marker, "global-extension-loaded\n", { mode: 0o600 });
}
