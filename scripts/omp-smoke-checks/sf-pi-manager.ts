/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sf-pi-manager offline behavior in native OMP. The smoke host is headless RPC,
 * so bare /sf-pi takes its documented text fallback; enable/disable persist as
 * OMP-native `disabledExtensions` in the hermetic agent config.yml.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyCheckoutUpdate,
  planCheckoutUpdate,
} from "../../extensions/sf-pi-manager/lib/auto-update-checkout.ts";
import type { SmokeApi } from "../omp-smoke-extension.ts";
import { OMP_VERSION } from "../omp-runtime.ts";

const EXTENSION = "sf-pi-manager";

async function agentConfig(): Promise<string> {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Error("Smoke OMP process has no PI_CODING_AGENT_DIR.");
  return readFile(path.join(agentDir, "config.yml"), "utf8").catch(() => "");
}

function fixtureGit(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args],
    { cwd, stdio: "ignore" },
  );
}

export default async function managerChecks(api: SmokeApi): Promise<void> {
  await api.run("pi-manager.command.no-args.fallback", EXTENSION, async () => {
    const output = await api.runCommand("sf-pi", "");
    api.requireTrue(
      /sf-pi v\S+ — (\d+)\/\1 extensions enabled/.test(output.text) &&
        !output.text.includes("package not found"),
      `Bare /sf-pi did not list the OMP-loaded catalog: ${output.text}`,
    );
    return output.notifications[0]?.message.split("\n")[0];
  });

  await api.run("pi-manager.command.status", EXTENSION, async () => {
    const output = await api.runCommand("sf-pi", "status");
    const configPath = path.join(process.env.PI_CODING_AGENT_DIR ?? "", "config.yml");
    api.requireTrue(
      output.text.includes("Host: OMP") && output.text.includes(`Enablement config: ${configPath}`),
      `Status did not report the OMP enablement config: ${output.text}`,
    );
    return "OMP enablement config reported";
  });

  await api.run("pi-manager.command.completions", EXTENSION, async () => {
    const completions = api.command("sf-pi")?.getArgumentCompletions?.("ena");
    const labels = Array.isArray(completions)
      ? completions.map((entry: { label?: unknown }) => entry.label)
      : [];
    api.requireTrue(
      labels.includes("enable") && labels.includes("enable-all"),
      `Unexpected /sf-pi completions: ${JSON.stringify(completions)}`,
    );
    return labels;
  });

  await api.run("pi-manager.enablement.disable-enable", EXTENSION, async () => {
    const disabled = await api.runCommand("sf-pi", "disable sf-tldraw");
    api.requireTrue(
      disabled.text.includes("Restart OMP to apply") &&
        (await agentConfig()).includes("extension-module:sf-tldraw"),
      `Disable did not persist OMP disabledExtensions: ${disabled.text}`,
    );
    const listed = await api.runCommand("sf-pi", "list");
    api.requireTrue(
      /○ SF tldraw .*— disabled/.test(listed.text),
      `List does not show the disabled extension: ${listed.text}`,
    );
    const enabled = await api.runCommand("sf-pi", "enable sf-tldraw");
    api.requireTrue(
      enabled.text.includes("Restart OMP to apply") &&
        !(await agentConfig()).includes("extension-module:sf-tldraw"),
      `Enable did not remove the OMP disabledExtensions entry: ${enabled.text}`,
    );
    const refused = await api.runCommand("sf-pi", "disable sf-pi-manager");
    api.requireTrue(
      refused.text.includes("always active") &&
        !(await agentConfig()).includes("extension-module:sf-pi-manager"),
      `The always-active manager was not protected: ${refused.text}`,
    );
    return "disable → list → enable round-trip in OMP config.yml";
  });

  await api.run("pi-manager.preferences.display", EXTENSION, async () => {
    const before = await api.runCommand("sf-pi", "display");
    const original = /sf-pi display profile: (\w+)/.exec(before.text)?.[1];
    api.requireTrue(original, `Display profile was not readable: ${before.text}`);
    const next = original === "compact" ? "verbose" : "compact";
    await api.runCommand("sf-pi", `display ${next} global`);
    const after = await api.runCommand("sf-pi", "display");
    await api.runCommand("sf-pi", `display ${original} global`);
    api.requireTrue(
      after.text.includes(`sf-pi display profile: ${next}`),
      `Display preference write was not read back: ${after.text}`,
    );
    return `${original} → ${next} → ${original}`;
  });

  await api.run("pi-manager.command.doctor.runtime", EXTENSION, async () => {
    const output = await api.runCommand("sf-pi", "doctor runtime");
    api.requireTrue(
      output.text.includes("sf-pi Runtime Doctor") &&
        output.text.includes(`Host runtime:     OMP ${OMP_VERSION}`),
      `Runtime doctor did not report the OMP host: ${output.text}`,
    );
    return output.text.split("\n").slice(0, 4);
  });

  await api.run("pi-manager.recommended.omp-unsupported", EXTENSION, async () => {
    const status = await api.runCommand("sf-pi", "recommended status");
    api.requireTrue(
      /Recommended extensions \(OMP host\): \d+ unsupported/.test(status.text) &&
        status.text.includes("explicit-only") &&
        status.text.includes("Under OMP: OMP's native web search and fetch tools."),
      `Recommended status did not report OMP support: ${status.text}`,
    );
    const install = await api.runCommand("sf-pi", "recommended install pi-web-access");
    api.requireTrue(
      install.notifications.some(
        (entry) =>
          entry.level === "warning" &&
          entry.message.includes("recommended install is not supported under sf-omp"),
      ),
      `Recommended install was not refused: ${install.text}`,
    );
    return status.text.split("\n")[0];
  });

  await api.run("pi-manager.auto-update.help.omp", EXTENSION, async () => {
    const help = await api.runCommand("sf-pi", "auto-update help");
    api.requireTrue(
      help.text.includes("git pull --ff-only + npm ci") && !help.text.includes("pi update"),
      `Auto Update help does not describe the checkout update: ${help.text}`,
    );
    return "checkout-based targets";
  });

  await api.run("pi-manager.auto-update.checkout.fixture", EXTENSION, async () => {
    // A local bare upstream under the smoke workspace stands in for origin.
    const root = path.join(api.workspace, "sf-omp-checkout-fixture");
    const seed = path.join(root, "seed");
    const checkout = path.join(root, "checkout");
    const writer = path.join(root, "writer");
    mkdirSync(seed, { recursive: true });
    fixtureGit(seed, "init", "-q", "-b", "main");
    writeFileSync(path.join(seed, "README.md"), "v1\n");
    fixtureGit(seed, "add", "README.md");
    fixtureGit(seed, "commit", "-q", "-m", "v1");
    fixtureGit(root, "clone", "-q", "--bare", seed, "upstream.git");
    fixtureGit(root, "clone", "-q", "upstream.git", checkout);
    fixtureGit(root, "clone", "-q", "upstream.git", writer);
    writeFileSync(path.join(writer, "README.md"), "v2\n");
    fixtureGit(writer, "commit", "-q", "-am", "v2");
    fixtureGit(writer, "push", "-q");

    // Real git through the module; npm ci is recorded so smoke installs nothing.
    const recorded: string[] = [];
    const exec: Pick<ExtensionAPI, "exec"> = {
      exec: async (command, args, options) => {
        if (command !== "git") {
          recorded.push(`${command} ${args.join(" ")}`);
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        const result = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8" });
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          code: result.status ?? 1,
          killed: false,
        };
      },
    };
    const plan = await planCheckoutUpdate(exec, { root: checkout });
    api.requireTrue(
      plan.state === "behind" && plan.behind === 1,
      `Unexpected plan: ${JSON.stringify(plan)}`,
    );
    const applied = await applyCheckoutUpdate(exec, plan, { root: checkout });
    api.requireTrue(
      applied.result === "success" &&
        readFileSync(path.join(checkout, "README.md"), "utf8") === "v2\n" &&
        recorded.join("|") === "npm ci",
      `Checkout fast-forward failed: ${JSON.stringify({ applied, recorded })}`,
    );
    const after = await planCheckoutUpdate(exec, { root: checkout });
    api.requireTrue(after.state === "current", `Checkout not current: ${after.message}`);
    return `${plan.message} → ${after.message}`;
  });

  api.skip(
    "pi-manager.auto-update.checkout.live",
    EXTENSION,
    "not-tested",
    "Fetching the real alexander-vyh/sf-omp upstream and running npm ci need the network.",
  );
}
