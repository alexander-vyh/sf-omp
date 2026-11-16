/* SPDX-License-Identifier: Apache-2.0 */
/** Offline OMP checks for sf-llm-gateway: real commands with no Gateway credential. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-llm-gateway";

export default async function checks(api: SmokeApi): Promise<void> {
  await api.run("gateway.command.registered", ID, async () => {
    const command = api.command(ID);
    api.requireTrue(command?.extension === ID, "Expected the real /sf-llm-gateway command.");
    return { name: command.name };
  });

  await api.run("gateway.status.no-credential", ID, async () => {
    const output = await api.runCommand(ID, "status");
    api.requireTrue(output.text.includes("SF LLM Gateway"), `Unexpected status: ${output.text}`);
    api.requireTrue(
      output.text.includes("Credential: missing"),
      `Status must report the missing credential: ${output.text}`,
    );
    return { excerpt: output.text.slice(0, 400) };
  });

  await api.run("gateway.help", ID, async () => {
    const output = await api.runCommand(ID, "help");
    api.requireTrue(/refresh/.test(output.text) && /doctor/.test(output.text), output.text);
    return { length: output.text.length };
  });

  await api.run("gateway.models.empty-catalog", ID, async () => {
    const output = await api.runCommand(ID, "models");
    api.requireTrue(output.text.includes("Registered models"), output.text);
    return { excerpt: output.text.slice(0, 300) };
  });

  await api.run("gateway.refresh.requires-credential", ID, async () => {
    const output = await api.runCommand(ID, "refresh");
    api.requireTrue(
      output.text.includes("requires a configured root URL and API key"),
      `Refresh without credential must stop before discovery: ${output.text}`,
    );
    return { excerpt: output.text.slice(0, 300) };
  });

  await api.run("gateway.priority.status", ID, async () => {
    const output = await api.runCommand(ID, "priority status");
    api.requireTrue(/priority/i.test(output.text), output.text);
    return { excerpt: output.text.slice(0, 300) };
  });

  // OMP reads model selection from <agentDir>/config.yml, not Pi's settings.json.
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const ompConfig = path.join(agentDir ?? "", "config.yml");
  await api.run("gateway.on.no-credential-keeps-omp-models", ID, async () => {
    api.requireTrue(agentDir, "Smoke must run with an isolated agent dir.");
    const before = await readFile(ompConfig, "utf8").catch(() => "");
    const output = await api.runCommand(ID, "on");
    const after = await readFile(ompConfig, "utf8").catch(() => "");
    api.requireTrue(
      output.text.includes("needs configuration") && output.text.includes("/login sf-llm-gateway"),
      `on without a credential must stop at setup guidance: ${output.text}`,
    );
    // Scoping OMP's model list to an unusable provider would leave no working model.
    api.requireTrue(
      after === before && !after.includes("sf-llm-gateway/"),
      `on without a credential must not change OMP model selection: ${after}`,
    );
    return { excerpt: output.text.slice(0, 200) };
  });

  await api.run("gateway.off.leaves-no-gateway-selection", ID, async () => {
    const output = await api.runCommand(ID, "off");
    const config = await readFile(ompConfig, "utf8").catch(() => "");
    api.requireTrue(/disabled/i.test(output.text), `Unexpected off output: ${output.text}`);
    api.requireTrue(
      !config.includes("sf-llm-gateway/"),
      `off must leave no Gateway scope or default in OMP config: ${config}`,
    );
    return { excerpt: output.text.slice(0, 200) };
  });

  api.skip(
    "gateway.live.discovery-and-streaming",
    ID,
    "not-tested",
    "Needs a Gateway credential and endpoint; verified against a localhost fixture Gateway over OMP RPC instead (discovery, Messages and Responses streaming, error guidance).",
  );
}
