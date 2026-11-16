/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sf-ohana-spinner on OMP's genuine UI context: OMP has no setWorkingIndicator,
 * so the real session hooks must drive only setWorkingMessage. The smoke ctx is
 * headless, so the hooks run against the real host ui with hasUI forced on and
 * setWorkingMessage recorded instead of drawn.
 */
import { messages } from "../../extensions/sf-ohana-spinner/lib/messages.ts";
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-ohana-spinner";

export default async function ohanaChecks(api: SmokeApi): Promise<void> {
  await api.run("ohana.omp.working-message-rotation", ID, async () => {
    const base = api.ctx as object;
    const baseUi = Reflect.get(base, "ui") as object;
    const hostHasIndicator = typeof Reflect.get(baseUi, "setWorkingIndicator") === "function";
    const calls: Array<string | undefined> = [];
    const ui = new Proxy(baseUi, {
      get: (target, key) =>
        key === "setWorkingMessage"
          ? (message?: string) => calls.push(message)
          : Reflect.get(target, key),
    });
    const ctx = new Proxy(base, {
      get: (target, key) => (key === "hasUI" ? true : key === "ui" ? ui : Reflect.get(target, key)),
    });
    for (const handler of api.handlers(ID, "session_start"))
      await handler({ type: "session_start" }, ctx);
    const started = [...calls];
    for (const handler of api.handlers(ID, "session_shutdown"))
      await handler({ type: "session_shutdown" }, ctx);
    api.requireTrue(
      started.length === 1 && messages.includes(started[0] ?? ""),
      `Expected one Ohana catalog message at start, got ${JSON.stringify(started)}`,
    );
    api.requireTrue(
      calls.length === 2 && calls[1] === undefined,
      `Shutdown did not restore OMP's default working message: ${JSON.stringify(calls)}`,
    );
    return { hostHasIndicator, startMessage: started[0] };
  });
}
