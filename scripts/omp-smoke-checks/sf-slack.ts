/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sf-slack offline behavior in native OMP. A synthetic user token is stored in
 * OMP's hermetic auth storage and every Slack Web API call is answered by an
 * in-process fixture, so no request leaves the process.
 */
import type { SmokeApi } from "../omp-smoke-extension.ts";

const EXTENSION = "sf-slack";
const PROVIDER = "sf-slack";
const FIXTURE_TOKEN = "xoxp-omp-smoke-fixture";
const CHANNEL_ID = "C00000001";
const USER_ID = "U00000000";
// files:read and canvases:read are deliberately absent so scope gating hides
// slack_file and slack_canvas while the rest stay active.
const GRANTED_SCOPES = [
  "chat:write",
  "search:read",
  "channels:read",
  "channels:history",
  "groups:read",
  "users:read",
  "users:read.email",
].join(",");

const SLACK_TOOLS = [
  "slack",
  "slack_time_range",
  "slack_resolve",
  "slack_research",
  "slack_channel",
  "slack_user",
  "slack_file",
  "slack_canvas",
  "slack_send",
  "slack_schedule",
];

const channel = {
  id: CHANNEL_ID,
  name: "fixture-general",
  is_channel: true,
  is_member: true,
  num_members: 2,
  topic: { value: "Fixture topic" },
  purpose: { value: "Fixture purpose" },
};
const user = {
  id: USER_ID,
  name: "fixture-user",
  real_name: "Fixture User",
  profile: { display_name: "fixture-user", real_name: "Fixture User" },
};
const message = {
  type: "message",
  user: USER_ID,
  username: "fixture-user",
  ts: "1700000000.000100",
  text: "Fixture deploy note",
  channel: { id: CHANNEL_ID, name: "fixture-general" },
  permalink: `https://example.slack.com/archives/${CHANNEL_ID}/p1700000000000100`,
};

function fixtureBody(method: string): Record<string, unknown> | undefined {
  switch (method) {
    case "auth.test":
      return { ok: true, user_id: USER_ID, user: "fixture-user", team_id: "T00000000" };
    case "users.list":
      return { ok: true, members: [user], response_metadata: { next_cursor: "" } };
    case "users.info":
      return { ok: true, user };
    case "conversations.list":
      return { ok: true, channels: [channel], response_metadata: { next_cursor: "" } };
    case "conversations.info":
      return { ok: true, channel };
    case "conversations.history":
      return { ok: true, messages: [message], has_more: false };
    case "search.messages":
      return {
        ok: true,
        messages: {
          total: 1,
          matches: [message],
          paging: { count: 1, total: 1, page: 1, pages: 1 },
        },
      };
    case "chat.postMessage":
      return { ok: true, channel: CHANNEL_ID, ts: "1700000001.000200" };
    case "chat.getPermalink":
      return {
        ok: true,
        permalink: `https://example.slack.com/archives/${CHANNEL_ID}/p1700000001000200`,
      };
    case "chat.scheduledMessages.list":
      return { ok: true, scheduled_messages: [], response_metadata: { next_cursor: "" } };
    default:
      return undefined;
  }
}

/** Run `action` with fetch answered by Slack fixtures; returns the Slack methods called. */
async function withSlackFixtures<T>(
  action: () => Promise<T>,
): Promise<{ value: T; methods: string[] }> {
  const original = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    const input = args[0];
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = /^https:\/\/slack\.com\/api\/([^?]+)/.exec(url);
    if (!match) return await original(...args);
    const method = match[1];
    methods.push(method);
    const body = fixtureBody(method) ?? { ok: false, error: `fixture_unhandled:${method}` };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "x-oauth-scopes": GRANTED_SCOPES },
    });
  }, original);
  try {
    return { value: await action(), methods };
  } finally {
    globalThis.fetch = original;
  }
}

function text(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const { content } = result;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("\n");
}

/** The slice of OMP's ExtensionContext these checks use. */
interface SlackSmokeContext {
  hasUI: boolean;
  modelRegistry: {
    authStorage: {
      credentials: {
        set(provider: string, credential: { type: "api_key"; key: string }): Promise<void>;
        remove(provider: string): Promise<void>;
      };
    };
  };
}

/**
 * Run a real command handler with a host context whose `ui.notify` is captured.
 * The genuine context is proxied (not copied) so every other member, including
 * the session manager, stays the host's own.
 */
async function captureCommandOutput(
  ctx: object,
  run: (commandCtx: object) => Promise<unknown>,
): Promise<string[]> {
  const lines: string[] = [];
  const ui: unknown = Reflect.get(ctx, "ui");
  if (!ui || typeof ui !== "object") throw new Error("Host context has no ui.");
  const uiProxy = new Proxy(ui, {
    get(target, property) {
      if (property === "notify") {
        return (message: string) => {
          lines.push(message);
        };
      }
      const member: unknown = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  const commandCtx = new Proxy(ctx, {
    get(target, property) {
      if (property === "ui") return uiProxy;
      const member: unknown = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  await run(commandCtx);
  return lines;
}

export default async function slackChecks(api: SmokeApi): Promise<void> {
  // api.ctx is the genuine OMP ExtensionContext captured at native session_start.
  const ctx = api.ctx as SlackSmokeContext;
  const command = api.command("sf-slack");

  await api.run("sf-slack.unconfigured", EXTENSION, async () => {
    api.requireTrue(command, "Expected the real /sf-slack command.");
    api.requireTrue(
      !api.pi.getActiveTools().some((name) => SLACK_TOOLS.includes(name)),
      "Slack tools must stay inactive without a credential.",
    );
    const missing = await api.invoke("slack_time_range", { expression: "last week" }).then(
      () => "registered",
      (error: unknown) => String(error),
    );
    api.requireTrue(
      missing !== "registered",
      "Slack tools must not register before a credential resolves.",
    );
    return { activeSlackTools: 0 };
  });
  if (!command) return;

  await ctx.modelRegistry.authStorage.credentials.set(PROVIDER, {
    type: "api_key",
    key: FIXTURE_TOKEN,
  });
  const allowHeadless = process.env.SLACK_ALLOW_HEADLESS_SEND;
  delete process.env.SLACK_ALLOW_HEADLESS_SEND;
  try {
    await api.run("sf-slack.refresh.scope-gating", EXTENSION, async () => {
      const { methods } = await withSlackFixtures(() => command.handler("refresh", api.ctx));
      api.requireTrue(methods.includes("auth.test"), `refresh never called auth.test: ${methods}`);
      const registered = new Set(api.pi.getAllTools().map((tool) => tool.name));
      const missing = SLACK_TOOLS.filter((name) => !registered.has(name));
      api.requireTrue(missing.length === 0, `Slack tools not registered: ${missing}`);
      const active = api.pi.getActiveTools().filter((name) => SLACK_TOOLS.includes(name));
      for (const gated of ["slack_file", "slack_canvas"]) {
        api.requireTrue(!active.includes(gated), `${gated} should be scope-gated off.`);
      }
      for (const kept of ["slack", "slack_send", "slack_schedule", "slack_user"]) {
        api.requireTrue(active.includes(kept), `${kept} should be active: ${active}`);
      }
      return { methods, active };
    });

    await api.run("sf-slack.command.status", EXTENSION, async () => {
      const [status, help, sent] = await captureCommandOutput(ctx, async (commandCtx) => {
        await command.handler("status", commandCtx);
        await command.handler("help", commandCtx);
        await command.handler("sent", commandCtx);
      });
      api.requireTrue(status?.includes("Status: ✅ Connected"), `status: ${status}`);
      api.requireTrue(!status.includes(FIXTURE_TOKEN), "status must never echo the token.");
      api.requireTrue(help?.includes("/sf-slack refresh"), `help: ${help}`);
      api.requireTrue(sent?.includes("No slack_send activity"), `sent: ${sent}`);
      return { status: status.split("\n").slice(0, 4) };
    });

    await api.run("sf-slack.time-range", EXTENSION, async () => {
      const result = await api.requireSuccess("slack_time_range", {
        expression: "2026-04-13 to 2026-04-20",
        timezone: "UTC",
      });
      const details = api.details(result);
      api.requireTrue(text(result).includes("2026-04-13"), text(result));
      return { oldest: details.oldest, latest: details.latest };
    });

    await api.run("sf-slack.search", EXTENSION, async () => {
      const { value, methods } = await withSlackFixtures(() =>
        api.requireSuccess("slack", { action: "search", query: "deploy", fields: "full" }),
      );
      api.requireTrue(
        text(value).includes("Fixture deploy note"),
        `search missed fixture: ${text(value)}`,
      );
      return { methods };
    });

    await api.run("sf-slack.history", EXTENSION, async () => {
      const { value, methods } = await withSlackFixtures(() =>
        api.requireSuccess("slack", { action: "history", channel: CHANNEL_ID, fields: "full" }),
      );
      api.requireTrue(text(value).includes("Fixture deploy note"), text(value));
      return { methods };
    });

    await api.run("sf-slack.resolve-channel", EXTENSION, async () => {
      const { value, methods } = await withSlackFixtures(() =>
        api.requireSuccess("slack_resolve", { type: "channel", text: "fixture-general" }),
      );
      api.requireTrue(text(value).includes(CHANNEL_ID), text(value));
      return { methods };
    });

    await api.run("sf-slack.channel-info", EXTENSION, async () => {
      const { value, methods } = await withSlackFixtures(() =>
        api.requireSuccess("slack_channel", { action: "info", channel: CHANNEL_ID }),
      );
      api.requireTrue(text(value).includes("fixture-general"), text(value));
      return { methods };
    });

    await api.run("sf-slack.user-info", EXTENSION, async () => {
      const { value, methods } = await withSlackFixtures(() =>
        api.requireSuccess("slack_user", { action: "info", user: USER_ID }),
      );
      api.requireTrue(text(value).includes("Fixture User"), text(value));
      return { methods };
    });

    await api.run("sf-slack.send.headless-refused", EXTENSION, async () => {
      api.requireTrue(!ctx.hasUI, "Smoke expects a headless host context.");
      const { value, methods } = await withSlackFixtures(() =>
        api.invoke("slack_send", { action: "channel", to: CHANNEL_ID, text: "Fixture hello" }),
      );
      api.requireTrue(api.details(value).reason === "headless_refused", text(value));
      api.requireTrue(
        !methods.includes("chat.postMessage"),
        "A refused send must not reach chat.postMessage.",
      );
      return { reason: "headless_refused", methods };
    });

    await api.run("sf-slack.schedule.headless-refused", EXTENSION, async () => {
      const { value, methods } = await withSlackFixtures(() =>
        api.invoke("slack_schedule", {
          action: "schedule",
          channel_id: CHANNEL_ID,
          message: "Fixture later",
          post_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      );
      api.requireTrue(api.details(value).reason === "headless_refused", `schedule: ${text(value)}`);
      api.requireTrue(!methods.includes("chat.scheduleMessage"), "Refused schedule posted.");
      return { reason: "headless_refused" };
    });

    await api.run("sf-slack.send.headless-opt-in", EXTENSION, async () => {
      process.env.SLACK_ALLOW_HEADLESS_SEND = "1";
      try {
        const { value, methods } = await withSlackFixtures(() =>
          api.requireSuccess("slack_send", {
            action: "channel",
            to: CHANNEL_ID,
            text: "Fixture hello",
          }),
        );
        api.requireTrue(methods.includes("chat.postMessage"), `methods: ${methods}`);
        api.requireTrue(api.details(value).message_ts === "1700000001.000200", text(value));
        const notifications = await captureCommandOutput(ctx, (commandCtx) =>
          command.handler("sent", commandCtx),
        );
        api.requireTrue(
          notifications.some((line) => line.includes("Fixture hello")),
          `send audit missing from /sf-slack sent: ${notifications}`,
        );
        return { methods };
      } finally {
        delete process.env.SLACK_ALLOW_HEADLESS_SEND;
      }
    });

    await api.run("sf-slack.schedule.list", EXTENSION, async () => {
      const { value, methods } = await withSlackFixtures(() =>
        api.requireSuccess("slack_schedule", { action: "list" }),
      );
      api.requireTrue(methods.includes("chat.scheduledMessages.list"), `methods: ${methods}`);
      return { text: text(value).split("\n")[0] };
    });
  } finally {
    if (allowHeadless === undefined) delete process.env.SLACK_ALLOW_HEADLESS_SEND;
    else process.env.SLACK_ALLOW_HEADLESS_SEND = allowHeadless;
    await ctx.modelRegistry.authStorage.credentials.remove(PROVIDER);
  }

  await api.run("sf-slack.refresh.logged-out", EXTENSION, async () => {
    const { methods } = await withSlackFixtures(() => command.handler("refresh", api.ctx));
    api.requireTrue(methods.length === 0, `Logged-out refresh called Slack: ${methods}`);
    const active = api.pi.getActiveTools().filter((name) => SLACK_TOOLS.includes(name));
    api.requireTrue(active.length === 0, `Slack tools still active after logout: ${active}`);
    return { activeSlackTools: 0 };
  });

  await api.run("sf-slack.relogin.restores-tools", EXTENSION, async () => {
    // A non-Slack tool the user turned off while logged out must stay off.
    const before = api.pi.getActiveTools();
    const turnedOff = before.find((name) => !SLACK_TOOLS.includes(name) && name !== "read");
    api.requireTrue(turnedOff, `No non-Slack tool to turn off: ${before}`);
    await api.pi.setActiveTools(before.filter((name) => name !== turnedOff));
    await ctx.modelRegistry.authStorage.credentials.set(PROVIDER, {
      type: "api_key",
      key: FIXTURE_TOKEN,
    });
    try {
      const { methods } = await withSlackFixtures(() => command.handler("refresh", api.ctx));
      api.requireTrue(methods.includes("auth.test"), `re-login refresh skipped Slack: ${methods}`);
      const active = api.pi.getActiveTools();
      const expected = SLACK_TOOLS.filter(
        (name) => name !== "slack_file" && name !== "slack_canvas",
      );
      const missing = expected.filter((name) => !active.includes(name));
      api.requireTrue(missing.length === 0, `Slack tools not restored after re-login: ${missing}`);
      for (const gated of ["slack_file", "slack_canvas"]) {
        api.requireTrue(!active.includes(gated), `${gated} should stay scope-gated off.`);
      }
      api.requireTrue(!active.includes(turnedOff), `${turnedOff} was re-activated by Slack.`);
      return { restored: expected, keptOff: turnedOff };
    } finally {
      await ctx.modelRegistry.authStorage.credentials.remove(PROVIDER);
      await withSlackFixtures(() => command.handler("refresh", api.ctx));
      await api.pi.setActiveTools([
        ...api.pi.getActiveTools().filter((name) => !SLACK_TOOLS.includes(name)),
        turnedOff,
      ]);
    }
  });
}
