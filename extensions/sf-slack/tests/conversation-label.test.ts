/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Behavior Proof for conversation labels in thread/history output: channels
 * read as `#name`, DMs after the other member, and group DMs after their
 * members other than the caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getChannelCache,
  getConversationLabelCache,
  getUserCache,
  resolveConversationLabel,
  setDetectedTeamId,
  setDetectedUserId,
} from "../lib/api.ts";
import { registerSlackTool } from "../lib/tools.ts";

type Payload = Record<string, unknown>;

const SELF_ID = "U01SELF0001";
const users: Record<string, string> = {
  U01ALICE001: "alice",
  U01BOB00001: "bob",
  [SELF_ID]: "me",
};

let endpointCalls: string[] = [];

function stubSlack(handlers: Record<string, (params: URLSearchParams) => Payload>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof request === "string" || request instanceof URL ? request : request.url,
      );
      const endpoint = url.pathname.split("/").filter(Boolean).at(-1)!;
      endpointCalls.push(endpoint);
      const params = new URLSearchParams(String(init?.body ?? ""));
      const users_info = (p: URLSearchParams): Payload => {
        const id = p.get("user") ?? "";
        return users[id]
          ? { ok: true, user: { id, name: users[id], profile: { display_name: users[id] } } }
          : { ok: false, error: "user_not_found" };
      };
      const handler = handlers[endpoint] ?? (endpoint === "users.info" ? users_info : undefined);
      const payload = handler ? handler(params) : { ok: false, error: "unexpected_endpoint" };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function resetCaches(): void {
  getChannelCache().clear();
  getUserCache().clear();
  getConversationLabelCache().clear();
  setDetectedTeamId(undefined);
  setDetectedUserId(undefined);
}

describe("resolveConversationLabel", () => {
  beforeEach(() => {
    resetCaches();
    endpointCalls = [];
    vi.stubEnv("SLACK_TEAM_ID", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetCaches();
  });

  it("labels a channel by name", async () => {
    stubSlack({
      "conversations.info": () => ({ ok: true, channel: { id: "C01ABCDEF23", name: "team-ops" } }),
    });

    await expect(resolveConversationLabel("xoxp-test", "C01ABCDEF23")).resolves.toBe("#team-ops");
    expect(getChannelCache().get("C01ABCDEF23")).toBe("team-ops");
  });

  it("labels a DM after the other member", async () => {
    stubSlack({
      "conversations.info": () => ({
        ok: true,
        channel: { id: "D01ABCDEF23", is_im: true, user: "U01ALICE001" },
      }),
    });

    await expect(resolveConversationLabel("xoxp-test", "D01ABCDEF23")).resolves.toBe(
      "DM with alice",
    );
    // DMs have no channel name, so the name cache used for matching stays clean.
    expect(getChannelCache().has("D01ABCDEF23")).toBe(false);
  });

  it("labels a group DM after its members, leaving out the caller", async () => {
    setDetectedUserId(SELF_ID);
    stubSlack({
      "conversations.info": () => ({
        ok: true,
        channel: { id: "C01GROUP001", is_mpim: true, name: "mpdm-alice--me--bob-1" },
      }),
      "conversations.members": () => ({
        ok: true,
        members: ["U01ALICE001", SELF_ID, "U01BOB00001"],
      }),
    });

    await expect(resolveConversationLabel("xoxp-test", "C01GROUP001")).resolves.toBe(
      "Group DM with alice, bob",
    );
  });

  it("relabels group DMs for a newly authenticated user", async () => {
    stubSlack({
      "conversations.info": () => ({
        ok: true,
        channel: { id: "C01GROUP001", is_mpim: true, name: "mpdm-alice--me--bob-1" },
      }),
      "conversations.members": () => ({
        ok: true,
        members: ["U01ALICE001", SELF_ID, "U01BOB00001"],
      }),
    });

    setDetectedUserId(SELF_ID);
    await expect(resolveConversationLabel("xoxp-test", "C01GROUP001")).resolves.toBe(
      "Group DM with alice, bob",
    );

    setDetectedUserId("U01ALICE001");
    await expect(resolveConversationLabel("xoxp-test", "C01GROUP001")).resolves.toBe(
      "Group DM with me, bob",
    );
  });

  it("falls back to the group DM slug when membership is unavailable", async () => {
    stubSlack({
      "conversations.info": () => ({
        ok: true,
        channel: { id: "C01GROUP001", is_mpim: true, name: "mpdm-alice--me--bob-1" },
      }),
      "conversations.members": () => ({ ok: false, error: "missing_scope" }),
    });

    await expect(resolveConversationLabel("xoxp-test", "C01GROUP001")).resolves.toBe(
      "#mpdm-alice--me--bob-1",
    );
  });

  it("returns no label for an inaccessible conversation without searching", async () => {
    stubSlack({ "conversations.info": () => ({ ok: false, error: "channel_not_found" }) });

    await expect(resolveConversationLabel("xoxp-test", "C01ABCDEF23")).resolves.toBeUndefined();
    expect(endpointCalls).toEqual(["conversations.info"]);
  });

  it("uses search only when conversations.info lacks scope", async () => {
    stubSlack({
      "conversations.info": () => ({ ok: false, error: "missing_scope", needed: "channels:read" }),
      "assistant.search.context": () => ({
        ok: true,
        results: { messages: [{ channel_id: "C01ABCDEF23", channel_name: "team-ops" }] },
      }),
    });

    await expect(resolveConversationLabel("xoxp-test", "C01ABCDEF23")).resolves.toBe("#team-ops");
  });
});

type ToolResult = { content: Array<{ text: string }>; details: Record<string, unknown> };

async function runSlackTool(params: Record<string, unknown>): Promise<ToolResult> {
  const captured: Array<{ name: string; execute?: (...args: never[]) => Promise<unknown> }> = [];
  registerSlackTool({ registerTool: (definition: never) => captured.push(definition) } as never);
  const tool = captured.find((entry) => entry.name === "slack")!;
  return (await tool.execute!(
    "tool-call" as never,
    params as never,
    undefined as never,
    undefined as never,
    {
      cwd: "/tmp/sf-slack-conversation-label-test",
      hasUI: false,
      modelRegistry: { getApiKeyForProvider: vi.fn(async () => "xoxp-test") },
    } as never,
  )) as ToolResult;
}

const DM_INFO = {
  ok: true,
  channel: { id: "D01ABCDEF23", is_im: true, user: "U01ALICE001" },
};
const ALICE_MESSAGE = {
  type: "message",
  user: "U01ALICE001",
  text: "hello",
  ts: "1700000000.100001",
};

describe("slack thread/history conversation header", () => {
  beforeEach(() => {
    resetCaches();
    endpointCalls = [];
    vi.stubEnv("SLACK_TEAM_ID", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetCaches();
  });

  it("names the DM a direct permalink read came from", async () => {
    stubSlack({
      "conversations.replies": () => ({ ok: true, messages: [ALICE_MESSAGE], has_more: false }),
      "conversations.info": () => DM_INFO,
    });

    const result = await runSlackTool({
      action: "thread",
      message_url: "https://example.enterprise.slack.com/archives/D01ABCDEF23/p1700000000100001",
    });

    expect(result.content[0].text.split("\n")[0]).toBe("Conversation: DM with alice (D01ABCDEF23)");
    expect(result.details).toMatchObject({
      channel: "D01ABCDEF23",
      channel_label: "DM with alice",
    });
    // The read runs first, so an inaccessible permalink still fails on it alone.
    expect(endpointCalls[0]).toBe("conversations.replies");
  });

  it("reads DM history by ID headlessly and names the other member", async () => {
    stubSlack({
      "conversations.history": () => ({ ok: true, messages: [ALICE_MESSAGE], has_more: false }),
      "conversations.info": () => DM_INFO,
    });

    const result = await runSlackTool({ action: "history", channel: "D01ABCDEF23" });

    expect(result.details).toMatchObject({
      ok: true,
      channel: "D01ABCDEF23",
      channel_label: "DM with alice",
    });
    expect(result.content[0].text.split("\n")[0]).toBe("Conversation: DM with alice (D01ABCDEF23)");
  });
});
