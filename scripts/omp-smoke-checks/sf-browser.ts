/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import type * as SnapshotStateModule from "../../lib/common/sf-browser-snapshot-state.ts";
import type * as AgentBrowserModule from "../../extensions/sf-browser/lib/agent-browser.ts";
import type * as ImageResizeModule from "../../extensions/sf-browser/lib/image-resize.ts";
import type { SmokeApi } from "../omp-smoke-extension.ts";

const ID = "sf-browser";
const INSTALL_HINT = "agent-browser is required for SF Browser runtime actions.";

// The same accessibility-tree line shape agent-browser publishes from `snapshot -i -c`.
const FIXTURE_SNAPSHOT = [
  '- button "Save" [ref=e1]',
  '- checkbox "Enable Feature" [checked=false, disabled, ref=e2]',
  '- textbox "Name" [ref=e3]',
  '- combobox "Stage" [ref=e4]',
].join("\n");

// Local page for real agent-browser runs; every control reports its effect in #status.
const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>SF Browser smoke fixture</title></head>
<body><main>
<h1>SF Browser smoke fixture</h1>
<label for="name">Name</label> <input id="name" type="text">
<label for="stage">Stage</label>
<select id="stage"><option value="Prospecting">Prospecting</option><option value="Closed Won">Closed Won</option></select>
<input id="feature" type="checkbox"> <label for="feature">Enable Feature</label>
<button id="details" type="button" aria-expanded="false" aria-controls="panel">Show details</button>
<div id="panel" hidden>Details panel</div>
<label for="notes">Notes</label> <textarea id="notes"></textarea>
<button id="save" type="button">Save</button>
<p id="status" role="status">Ready</p>
</main>
<script>
const status = document.getElementById("status");
document.getElementById("save").addEventListener("click", () => {
  status.textContent = "Saved " + document.getElementById("name").value + " at " + document.getElementById("stage").value;
});
document.getElementById("details").addEventListener("click", (event) => {
  const open = event.currentTarget.getAttribute("aria-expanded") !== "true";
  event.currentTarget.setAttribute("aria-expanded", String(open));
  document.getElementById("panel").hidden = !open;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") status.textContent = "Escaped";
});
</script>
</body></html>
`;

function moduleUrl(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && key in value
    ? Reflect.get(value, key)
    : undefined;
}

export default async function check(api: SmokeApi): Promise<void> {
  const { requireTrue, details } = api;
  const sessionManager = field(api.ctx, "sessionManager");
  const getSessionId = field(sessionManager, "getSessionId");
  requireTrue(typeof getSessionId === "function", "Host ctx has no sessionManager.getSessionId.");
  const sessionId = String(Reflect.apply(getSessionId, sessionManager, []));
  // Load fork modules through OMP's legacy remapping, exactly as the extension graph sees them
  // (agent dir, shims). Type-only casts: the loader returns these exact modules as `unknown`.
  const { markLatestBrowserSnapshotStale, writeLatestBrowserSnapshotRefs } =
    (await loadLegacyPiModule(
      moduleUrl("../../lib/common/sf-browser-snapshot-state.ts"),
    )) as typeof SnapshotStateModule;

  async function rejection(tool: string, params: Record<string, unknown>): Promise<string> {
    try {
      const result = await api.invoke(tool, params);
      throw new Error(`${tool} unexpectedly succeeded: ${JSON.stringify(result)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith(`${tool} unexpectedly succeeded`)) throw error;
      return message;
    }
  }

  async function commandOutput(args: string, hasUI: boolean): Promise<string[]> {
    const command = api.command("sf-browser");
    requireTrue(command?.extension === ID, "/sf-browser is not registered by sf-browser.");
    const out: string[] = [];
    const base = api.ctx as object;
    const ui = new Proxy(Reflect.get(base, "ui") as object, {
      get: (target, key) =>
        key === "notify"
          ? (message: string, level?: string) => out.push(`${level ?? "info"}: ${message}`)
          : Reflect.get(target, key),
    });
    const commandCtx = new Proxy(base, {
      get: (target, key) =>
        key === "hasUI" ? hasUI : key === "ui" ? ui : Reflect.get(target, key),
    });
    // Without UI the command prints its body to stdout, as in OMP print mode.
    const info = console.info;
    console.info = (...values: unknown[]) => out.push(`stdout: ${values.join(" ")}`);
    try {
      await command.handler(args, commandCtx);
    } finally {
      console.info = info;
    }
    return out;
  }

  await api.run("browser.resolve_path.setup-alias", ID, async () => {
    const result = await api.requireSuccess("sf_browser_resolve_path", {
      target: { type: "setup", destination: "External Client App Manager" },
    });
    const value = details(result);
    requireTrue(
      value.destination === "external-client-apps" &&
        String(value.path).startsWith("/lightning/setup/"),
      `Unexpected Setup route: ${JSON.stringify(value)}`,
    );
    return { path: value.path, destination: value.destination, kind: value.kind };
  });

  await api.run("browser.resolve_path.local-routes", ID, async () => {
    const routes = {
      home: { type: "home" },
      objectList: { type: "object-list", objectApiName: "Account" },
      objectNew: { type: "object-new", objectApiName: "Contact" },
      recordView: { type: "record-view", objectApiName: "Account", recordId: "001000000000001AAA" },
      explicitPath: { type: "path", path: "/lightning/setup/SetupOneHome/home" },
    };
    const paths: Record<string, unknown> = {};
    for (const [name, target] of Object.entries(routes)) {
      paths[name] = details(await api.requireSuccess("sf_browser_resolve_path", { target })).path;
    }
    requireTrue(
      paths.objectList === "/lightning/o/Account/list" &&
        paths.objectNew === "/lightning/o/Contact/new" &&
        paths.recordView === "/lightning/r/Account/001000000000001AAA/view" &&
        paths.explicitPath === "/lightning/setup/SetupOneHome/home",
      `Unexpected local Lightning paths: ${JSON.stringify(paths)}`,
    );
    return paths;
  });

  await api.run("browser.resolve_path.needs-choice-and-unsupported", ID, async () => {
    const ambiguous = await api.invoke("sf_browser_resolve_path", {
      target: { type: "setup", destination: "apps" },
    });
    requireTrue(
      details(ambiguous).status === "needs-choice" &&
        field(ambiguous, "isError") !== true &&
        JSON.stringify(field(ambiguous, "content")).includes("Candidates:"),
      `Expected candidate list without error: ${JSON.stringify(ambiguous)}`,
    );
    const unsupported = await api.invoke("sf_browser_resolve_path", {
      target: { type: "setup", destination: "zzzz-unmapped" },
    });
    requireTrue(
      field(unsupported, "isError") === true &&
        details(unsupported).reason === "unknown_setup_destination",
      `Expected unsupported destination error: ${JSON.stringify(unsupported)}`,
    );
    return { ambiguous: details(ambiguous).status, unsupported: details(unsupported).reason };
  });

  await api.run("browser.open_org.route-planning-fails-before-network", ID, async () => {
    // Explicit target_org skips sf CLI lookup; the unknown destination must fail locally.
    const message = await rejection("sf_browser_open_org", {
      target_org: "sf-omp-smoke-unauthenticated",
      target: { type: "setup", destination: "zzzz-unmapped" },
    });
    requireTrue(/zzzz-unmapped/.test(message), `Unexpected open_org failure: ${message}`);
    return { message };
  });

  await api.run("browser.refs.missing-session-fails-closed", ID, async () => {
    const message = await rejection("sf_browser_click", { ref: "@e1" });
    requireTrue(
      message.includes("There is no current sf_browser_snapshot"),
      `Expected missing-snapshot guard: ${message}`,
    );
    return { message };
  });

  const snapshotPath = api.file("sf-browser-fixture-snapshot.txt");
  await writeFile(snapshotPath, `${FIXTURE_SNAPSHOT}\n`);
  writeLatestBrowserSnapshotRefs({
    sessionId,
    snapshot: FIXTURE_SNAPSHOT,
    url: "file:///sf-browser-fixture.html",
    fullSnapshotPath: snapshotPath,
  });

  await api.run("browser.refs.semantic-guards", ID, async () => {
    const unpublished = await rejection("sf_browser_click", { ref: "@e99" });
    requireTrue(
      unpublished.includes("was not published by the latest sf_browser_snapshot"),
      unpublished,
    );
    const notToggle = await rejection("sf_browser_set_toggle", { ref: "@e1", desiredState: true });
    requireTrue(notToggle.includes("not a checkbox or switch"), notToggle);
    const disabled = await rejection("sf_browser_set_toggle", { ref: "@e2", desiredState: true });
    requireTrue(disabled.includes("is disabled and cannot be changed"), disabled);
    const notDisclosure = await rejection("sf_browser_set_expanded", {
      ref: "@e1",
      desiredState: true,
    });
    requireTrue(notDisclosure.includes("is not an expandable control"), notDisclosure);
    return { unpublished, notToggle, disabled, notDisclosure };
  });

  await api.run("browser.image-resize.omp-host-adapter", ID, async () => {
    // In the legacy graph the Pi SDK specifier is OMP's shim (no resizeImage), so the
    // adapter's OMP host branch runs here, as it does inside the loaded extension.
    const { formatDimensionNote, resizeImage } = (await loadLegacyPiModule(
      moduleUrl("../../extensions/sf-browser/lib/image-resize.ts"),
    )) as typeof ImageResizeModule;
    const width = 3000;
    const height = 2000;
    // Opaque RGBA, like agent-browser screenshots; varied color defeats trivial compression.
    const pixels = new Uint8Array(width * height * 4);
    for (let index = 0; index < pixels.length; index += 1) {
      pixels[index] = index % 4 === 3 ? 255 : (index * 31) & 255;
    }
    const options = { maxWidth: 1440, maxHeight: 1000, maxBytes: 1_500_000, jpegQuality: 55 };
    const large = await resizeImage(encodeRawPng(pixels, width, height, 4), "image/png", options);
    requireTrue(large, "Large screenshot fixture failed to decode.");
    requireTrue(
      large.wasResized &&
        large.width <= 1440 &&
        large.height <= 1000 &&
        ["image/png", "image/jpeg"].includes(large.mimeType) &&
        Buffer.from(large.data, "base64").length <= 1_500_000,
      `Unexpected thumbnail: ${JSON.stringify({ ...large, data: large.data.length })}`,
    );
    const note = formatDimensionNote(large);
    requireTrue(
      note ===
        `[Image: original 3000x2000, displayed at ${large.width}x${large.height}. Multiply coordinates by ${(3000 / large.width).toFixed(2)} to map to original image.]`,
      `Unexpected dimension note: ${note}`,
    );
    const small = await resizeImage(
      encodeRawPng(new Uint8Array(50 * 40 * 4).fill(255), 50, 40, 4),
      "image/png",
      options,
    );
    requireTrue(
      small && !small.wasResized && small.width === 50 && formatDimensionNote(small) === undefined,
      `Small screenshots must not be upscaled: ${JSON.stringify(small && { ...small, data: 0 })}`,
    );
    const garbage = await resizeImage(new Uint8Array([1, 2, 3, 4]), "image/png", options);
    requireTrue(garbage === null, "Undecodable bytes must resolve null like Pi.");
    return { large: { mimeType: large.mimeType, width: large.width, height: large.height }, note };
  });

  await api.run("browser.command.help-guidance-status-evidence", ID, async () => {
    const help = (await commandOutput("help", true)).join("\n");
    requireTrue(
      help.includes("sf_browser_resolve_path") && help.includes("Setup destinations:"),
      help.slice(0, 300),
    );
    const guidance = (await commandOutput("guidance", true)).join("\n");
    requireTrue(guidance.length > 50, `Empty guidance: ${guidance}`);
    const status = (await commandOutput("", false)).join("\n");
    requireTrue(
      status.startsWith("stdout: ") && status.includes(`Pi session    ${sessionId}`),
      `No-UI no-args must print status: ${status}`,
    );
    const evidence = (await commandOutput("evidence 5", true)).join("\n");
    requireTrue(evidence.startsWith("info: "), `Unexpected evidence output: ${evidence}`);
    const unknown = (await commandOutput("bogus", true)).join("\n");
    requireTrue(
      unknown.includes("warning: Unknown /sf-browser subcommand: bogus"),
      `Unexpected unknown-subcommand output: ${unknown}`,
    );
    const completions = api.command("sf-browser")?.getArgumentCompletions?.("") as
      Array<{ value: string }> | null | undefined;
    const values = (completions ?? []).map((item) => item.value.trim());
    requireTrue(
      ["status", "doctor", "evidence", "help"].every((value) => values.includes(value)),
      `Missing completions: ${JSON.stringify(values)}`,
    );
    return { completions: values, evidence: evidence.slice(0, 200) };
  });

  await api.run("browser.refs.stale-after-navigation", ID, async () => {
    writeLatestBrowserSnapshotRefs({
      sessionId,
      snapshot: FIXTURE_SNAPSHOT,
      fullSnapshotPath: snapshotPath,
    });
    markLatestBrowserSnapshotStale(sessionId, "smoke navigation");
    const message = await rejection("sf_browser_fill", { ref: "@e3", value: "Smoke" });
    requireTrue(message.includes("is stale because the page changed"), message);
    return { message };
  });

  const doctor = (await commandOutput("doctor", true)).join("\n");
  if (doctor.includes("agent-browser: missing or not ready")) {
    await api.run("browser.runtime.missing-agent-browser-guidance", ID, async () => {
      requireTrue(doctor.includes("npm i -g agent-browser"), doctor);
      const failures: Record<string, string> = {};
      const calls: Array<[string, Record<string, unknown>]> = [
        ["sf_browser_snapshot", {}],
        ["sf_browser_click", { ref: "@e1" }],
        ["sf_browser_fill", { ref: "@e3", value: "Smoke" }],
        ["sf_browser_select", { ref: "@e4", values: ["Prospecting"] }],
        ["sf_browser_press", { key: "Escape" }],
        ["sf_browser_editor", { action: "detect" }],
        ["sf_browser_wait", { condition: { type: "delay", value: 1 } }],
        ["sf_browser_capture_evidence", { label: "smoke", imageMode: "artifact" }],
      ];
      for (const [tool, params] of calls) {
        // Fresh refs pass the guard and reach the real OMP exec boundary.
        writeLatestBrowserSnapshotRefs({
          sessionId,
          snapshot: FIXTURE_SNAPSHOT,
          fullSnapshotPath: snapshotPath,
        });
        failures[tool] = await rejection(tool, params);
        requireTrue(failures[tool].includes(INSTALL_HINT), `${tool}: ${failures[tool]}`);
      }
      const screenshot = (await commandOutput("screenshot smoke", true)).join("\n");
      requireTrue(screenshot.includes(INSTALL_HINT), `screenshot command: ${screenshot}`);
      return { doctor, tools: Object.keys(failures) };
    });
    api.skip(
      "browser.page.actions",
      ID,
      "blocked",
      "agent-browser is not provisioned. Run `bun scripts/provision-agent-browser.ts` (pinned agent-browser plus Chrome for Testing under .runtime/toolchains/agent-browser), then rerun `npm run smoke:omp`.",
    );
  } else {
    await pageActions(api, sessionId, doctor);
  }

  api.skip(
    "browser.org.open-and-navigate-setup",
    ID,
    "blocked",
    "sf_browser_open_org, sf_browser_navigate_setup and /sf-browser open|open-setup need an authenticated Salesforce org (single-access frontdoor URL) and agent-browser; live-only.",
  );
  api.skip(
    "browser.command.manager-panel",
    ID,
    "not-tested",
    "/sf-browser with no args in TUI opens the SF Pi Manager detail panel; smoke runs headless.",
  );
}

/** Real agent-browser + Chrome against a localhost fixture, through the registered tools. */
async function pageActions(api: SmokeApi, sessionId: string, doctor: string): Promise<void> {
  const { requireTrue, details } = api;
  // Type-only casts: OMP's legacy loader returns these exact modules as `unknown`.
  const { runAgentBrowser } = (await loadLegacyPiModule(
    moduleUrl("../../extensions/sf-browser/lib/agent-browser.ts"),
  )) as typeof AgentBrowserModule;
  const { findLatestBrowserSnapshotSession } = (await loadLegacyPiModule(
    moduleUrl("../../lib/common/sf-browser-snapshot-state.ts"),
  )) as typeof SnapshotStateModule;
  // runAgentBrowser only calls pi.exec, which OMP's ExtensionAPI provides with Pi's shape.
  const pi = api.pi as unknown as Parameters<typeof runAgentBrowser>[0];
  const cwd = api.workspace;
  const browser = async (args: string[]): Promise<string> =>
    (await runAgentBrowser(pi, args, { cwd, timeoutMs: 60_000 })).stdout.trim();
  const statusText = () => browser(["get", "text", "#status"]);

  async function refFor(roles: string[], label: string): Promise<string> {
    await api.requireSuccess("sf_browser_snapshot", { outputMode: "artifact" });
    const refs = findLatestBrowserSnapshotSession(sessionId)?.refs ?? [];
    const entry = refs.find(
      (item) => roles.includes(item.role?.toLowerCase() ?? "") && item.label === label,
    );
    requireTrue(
      entry,
      `No ${roles.join("/")} "${label}" in snapshot: ${JSON.stringify(refs.map((item) => item.line))}`,
    );
    return `@${entry.ref}`;
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(FIXTURE_HTML, { headers: { "content-type": "text/html" } }),
  });
  const url = `http://127.0.0.1:${server.port}/sf-browser-smoke.html`;
  try {
    await api.run("browser.page.open-fixture", ID, async () => {
      await browser(["open", url]);
      await browser(["wait", "--load", "load"]);
      return { doctor, url: await browser(["get", "url"]) };
    });

    await api.run("browser.page.snapshot", ID, async () => {
      const result = await api.requireSuccess("sf_browser_snapshot", {});
      const value = details(result);
      const refs = findLatestBrowserSnapshotSession(sessionId)?.refs ?? [];
      const labels = refs.map((item) => item.label);
      requireTrue(
        ["Name", "Stage", "Enable Feature", "Show details", "Save"].every((label) =>
          labels.includes(label),
        ) &&
          typeof value.fullSnapshotPath === "string" &&
          existsSync(value.fullSnapshotPath),
        `Snapshot missed fixture controls: ${JSON.stringify(refs.map((item) => item.line))}`,
      );
      return { refs: refs.map((item) => item.line), currentUrl: value.currentUrl };
    });

    await api.run("browser.page.fill", ID, async () => {
      const ref = await refFor(["textbox"], "Name");
      await api.requireSuccess("sf_browser_fill", { ref, value: "Acme" });
      const value = await browser(["get", "value", "#name"]);
      requireTrue(value === "Acme", `Name value: ${value}`);
      return { ref, value };
    });

    await api.run("browser.page.select", ID, async () => {
      const ref = await refFor(["combobox", "listbox"], "Stage");
      await api.requireSuccess("sf_browser_select", { ref, values: ["Closed Won"] });
      const value = await browser(["get", "value", "#stage"]);
      requireTrue(value === "Closed Won", `Stage value: ${value}`);
      return { ref, value };
    });

    await api.run("browser.page.set_toggle", ID, async () => {
      const ref = await refFor(["checkbox"], "Enable Feature");
      const result = await api.requireSuccess("sf_browser_set_toggle", {
        ref,
        desiredState: true,
        reason: "Smoke fixture toggle",
      });
      const checked = await browser(["eval", "document.getElementById('feature').checked"]);
      requireTrue(checked.includes("true"), `Checkbox state: ${checked}`);
      return { ref, checked, details: details(result) };
    });

    await api.run("browser.page.set_expanded", ID, async () => {
      const ref = await refFor(["button"], "Show details");
      const result = await api.requireSuccess("sf_browser_set_expanded", {
        ref,
        desiredState: true,
        reason: "Smoke fixture disclosure",
      });
      const expanded = await browser(["get", "attr", "#details", "aria-expanded"]);
      requireTrue(expanded === "true", `aria-expanded: ${expanded}`);
      return { ref, expanded, details: details(result) };
    });

    await api.run("browser.page.click", ID, async () => {
      const ref = await refFor(["button"], "Save");
      // mutation=true makes the tool capture before-mutation evidence (screenshot + thumbnail).
      const result = await api.requireSuccess("sf_browser_click", {
        ref,
        mutation: true,
        reason: "Save smoke fixture",
      });
      const status = await statusText();
      requireTrue(status === "Saved Acme at Closed Won", `Status after Save: ${status}`);
      return { ref, status, details: details(result) };
    });

    await api.run("browser.page.press-and-wait", ID, async () => {
      await api.requireSuccess("sf_browser_press", { key: "Escape" });
      const wait = await api.requireSuccess("sf_browser_wait", {
        condition: { type: "text", value: "Escaped" },
      });
      requireTrue(details(wait).status === "matched", `Wait: ${JSON.stringify(details(wait))}`);
      return { status: await statusText(), wait: details(wait).status };
    });

    await api.run("browser.page.editor", ID, async () => {
      const detect = await api.requireSuccess("sf_browser_editor", { action: "detect" });
      await api.requireSuccess("sf_browser_editor", { action: "write", value: "smoke notes" });
      const read = await api.requireSuccess("sf_browser_editor", { action: "read" });
      const notes = await browser(["get", "value", "#notes"]);
      requireTrue(notes === "smoke notes", `Textarea value: ${notes}`);
      return { detect: details(detect), read: details(read) };
    });

    await api.run("browser.page.capture_evidence", ID, async () => {
      const result = await api.requireSuccess("sf_browser_capture_evidence", {
        label: "smoke-fixture",
        imageMode: "thumbnail",
      });
      const capture = field(details(result), "capture");
      const shot = field(capture, "path");
      const thumbnail = field(capture, "thumbnailPath");
      const content = field(result, "content");
      const image = (Array.isArray(content) ? content : []).find(
        (part) => field(part, "type") === "image",
      );
      requireTrue(
        typeof shot === "string" &&
          existsSync(shot) &&
          typeof thumbnail === "string" &&
          existsSync(thumbnail) &&
          ["image/png", "image/jpeg"].includes(String(field(image, "mimeType"))),
        `Evidence capture: ${JSON.stringify(capture)}`,
      );
      return { capture, mimeType: field(image, "mimeType") };
    });
  } finally {
    await browser(["close"]).catch(() => undefined);
    void server.stop(true);
  }
}
