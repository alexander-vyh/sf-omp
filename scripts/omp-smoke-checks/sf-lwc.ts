/* SPDX-License-Identifier: Apache-2.0 */
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-lwc";

export default async function check(api: SmokeApi): Promise<void> {
  for (const sub of ["", "status", "help"]) {
    await api.run(`lwc.command.${sub || "no-args"}`, ID, async () => {
      const output = await api.runCommand(ID, sub);
      api.requireTrue(output.text.trim().length > 0, `/sf-lwc ${sub} produced no output.`);
      return { chars: output.text.length, head: output.text.slice(0, 160) };
    });
  }
}
