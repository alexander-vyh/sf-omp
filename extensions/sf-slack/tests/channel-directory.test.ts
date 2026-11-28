/* SPDX-License-Identifier: Apache-2.0 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDetectedTeamId } from "../lib/api.ts";
import { listChannelDirectory } from "../lib/channel-directory.ts";
import { registerChannelTool } from "../lib/channel-tool.ts";
import type { SlackToolResult } from "../lib/types.ts";

function channelTool() {
  let tool!: {
    execute: (...args: never[]) => Promise<SlackToolResult>;
    renderResult: (...args: never[]) => UiNode<"ansi">;
  };
  registerChannelTool({
    registerTool(definition: typeof tool) {
      tool = definition;
    },
  } as never);
  return tool;
}

function invoke(params: Record<string, unknown>, signal?: AbortSignal) {
  return channelTool().execute(
    ...([
      "directory-test",
      { action: "list", ...params },
      signal,
      undefined,
      {
        cwd: "/tmp",
        hasUI: false,
        modelRegistry: { getApiKeyForProvider: async () => "xoxp-test" },
      },
    ] as never[]),
  );
}

const options = { types: "public_channel,private_channel", limit: 200 };

beforeEach(() => {
  vi.stubEnv("SLACK_TEAM_ID", "");
  setDetectedTeamId(undefined);
});

afterEach(() => {
  setDetectedTeamId(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Enterprise Grid channel directory", () => {
  it("uses approved workspace IDs and retains workspace-specific cursors", async () => {
    setDetectedTeamId("EORGEXAMPLE");
    const requests: Array<[string | null, string | null, string | null]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = new URLSearchParams(String(init.body));
        if (url.endsWith("auth.teams.list")) {
          expect(body.has("team_id")).toBe(false);
          return Response.json(
            body.get("cursor") === "teams-next"
              ? { ok: true, teams: [{ id: "TSECOND" }] }
              : {
                  ok: true,
                  teams: [{ id: "TFIRST" }],
                  response_metadata: { next_cursor: "teams-next" },
                },
          );
        }
        expect(url.endsWith("conversations.list")).toBe(true);
        requests.push([body.get("team_id"), body.get("cursor"), body.get("types")]);
        expect(body.get("limit")).toBe("200");
        return Response.json({
          ok: true,
          channels: [{ id: "CEXAMPLE", name: "example-team", is_private: true }],
          response_metadata: {
            next_cursor:
              body.get("team_id") === "TFIRST" && !body.get("cursor") ? "first-next" : "",
          },
        });
      }),
    );
    const first = await listChannelDirectory("xoxp-test", options);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected first directory page");
    const second = await listChannelDirectory("xoxp-test", {
      ...options,
      cursor: first.data.response_metadata?.next_cursor,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("Expected second directory page");
    const third = await listChannelDirectory("xoxp-test", {
      ...options,
      cursor: second.data.response_metadata?.next_cursor,
    });
    expect(third).toMatchObject({ ok: true, data: { response_metadata: { next_cursor: "" } } });
    expect(requests).toEqual([
      ["TFIRST", null, options.types],
      ["TFIRST", "first-next", options.types],
      ["TSECOND", null, options.types],
    ]);
  });

  it("rediscovers the workspace when the detected identity cannot list it", async () => {
    setDetectedTeamId("TSTALE");
    const teams: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("auth.teams.list")) {
          return Response.json({ ok: true, teams: [{ id: "TAPPROVED" }] });
        }
        const team = new URLSearchParams(String(init.body)).get("team_id");
        teams.push(team);
        return Response.json(
          team === "TAPPROVED"
            ? { ok: true, channels: [{ id: "CEXAMPLE", name: "example-team" }] }
            : { ok: false, error: "team_access_not_granted" },
        );
      }),
    );
    expect(await listChannelDirectory("xoxp-test", options)).toMatchObject({
      ok: true,
      data: { channels: [{ name: "example-team" }] },
    });
    expect(teams).toEqual(["TSTALE", "TAPPROVED"]);
  });

  it("does not broaden an explicit workspace selection when access is denied", async () => {
    vi.stubEnv("SLACK_TEAM_ID", "TSELECTED");
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url.endsWith("conversations.list")).toBe(true);
      expect(new URLSearchParams(String(init.body)).get("team_id")).toBe("TSELECTED");
      return Response.json({ ok: false, error: "team_access_not_granted" });
    });
    vi.stubGlobal("fetch", fetch);
    expect(await listChannelDirectory("xoxp-test", options)).toEqual({
      ok: false,
      error: "team_access_not_granted",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves a workspace token's native pagination", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body));
      expect(body.has("team_id")).toBe(false);
      expect(body.get("cursor")).toBe("slack-native-cursor");
      return Response.json({ ok: true, channels: [], response_metadata: { next_cursor: "next" } });
    });
    vi.stubGlobal("fetch", fetch);
    expect(
      await listChannelDirectory("xoxp-test", { ...options, cursor: "slack-native-cursor" }),
    ).toMatchObject({ ok: true, data: { response_metadata: { next_cursor: "next" } } });
  });

  it("rejects malformed continuations and invalid explicit workspace IDs without requests", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      await listChannelDirectory("xoxp-test", { ...options, cursor: "sf-slack:broken" }),
    ).toEqual({ ok: false, error: "invalid_cursor" });
    vi.stubEnv("SLACK_TEAM_ID", "EORGEXAMPLE");
    expect(await listChannelDirectory("xoxp-test", options)).toMatchObject({
      ok: false,
      error: "invalid_arguments",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not turn an unavailable approved-workspace directory into empty success", async () => {
    setDetectedTeamId("EORGEXAMPLE");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, teams: [] })),
    );
    expect(await listChannelDirectory("xoxp-test", options)).toEqual({
      ok: false,
      error: "team_access_not_granted",
    });
  });
});

describe("slack_channel list behavior", () => {
  it("finds names beyond sparse directory pages without invoking message search", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url.endsWith("conversations.list")).toBe(true);
      const cursor = new URLSearchParams(String(init.body)).get("cursor");
      return Response.json(
        cursor
          ? { ok: true, channels: [{ id: "CTARGET", name: "example-support", is_private: true }] }
          : {
              ok: true,
              channels: [{ id: "COTHER", name: "general" }],
              response_metadata: { next_cursor: "next" },
            },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const result = await invoke({ ...options, name_filter: "EXAMPLE" });
    expect(result.details).toMatchObject({
      ok: true,
      channels: [{ id: "CTARGET", name: "example-support", isPrivate: true }],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns a truthful continuation when a bounded name scan has no matches yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          channels: [],
          response_metadata: { next_cursor: "still-more" },
        }),
      ),
    );
    const result = await invoke({ name_filter: "example" });
    expect(result.details).toMatchObject({ ok: true, count: 0, next_cursor: "still-more" });
    expect(result.content[0].text).toContain("continue with the cursor");
    const rendered = channelTool().renderResult(
      ...([
        result,
        { expanded: false, isPartial: false },
        { fg: (_color: string, value: string) => value },
      ] as never[]),
    );
    expect(rendered.props().text).toContain("more pages");
  });

  it("falls back on denied directory access, honoring name and channel-type filters", async () => {
    setDetectedTeamId("EORGEXAMPLE");
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("auth.teams.list")) {
          return Response.json({ ok: true, teams: [{ id: "TAPPROVED" }] });
        }
        if (url.endsWith("conversations.list")) {
          return Response.json({ ok: false, error: "team_access_not_granted" });
        }
        expect(url.endsWith("assistant.search.context")).toBe(true);
        const body = JSON.parse(String(init.body));
        expect(body.channel_types).toBe("private_channel");
        queries.push(body.query);
        return Response.json({
          ok: true,
          results: {
            messages: [
              { channel_id: "CMATCH", channel_name: "example-operations" },
              { channel_id: "COTHER", channel_name: "general" },
              { channel_id: "CMATCH", channel_name: "example-operations" },
            ],
          },
        });
      }),
    );
    const result = await invoke({ name_filter: "example", types: "private_channel", limit: 200 });
    expect(result.details).toMatchObject({
      ok: true,
      partial: true,
      fallback: true,
      count: 1,
      channels: [{ id: "CMATCH", name: "example-operations" }],
    });
    const channel = (result.details?.channels as Record<string, unknown>[])[0];
    expect(channel.isPrivate).toBeUndefined();
    expect(result.content[0].text).toContain("not a complete directory");
    expect(queries).toContain("example");
    const rendered = channelTool().renderResult(
      ...([
        result,
        { expanded: false, isPartial: false },
        { fg: (_color: string, value: string) => value },
      ] as never[]),
    );
    expect(rendered.props().text).toContain("not a complete directory");
  });

  it("keeps directory denial explicit when search discovery yields no name matches", async () => {
    vi.stubEnv("SLACK_TEAM_ID", "TSELECTED");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.endsWith("conversations.list")
            ? { ok: false, error: "team_access_not_granted" }
            : {
                ok: true,
                results: { messages: [{ channel_id: "COTHER", channel_name: "general" }] },
              },
        ),
      ),
    );
    const result = await invoke({ name_filter: "example" });
    expect(result.details).toMatchObject({ ok: false, reason: "team_access_not_granted" });
    expect(result.content[0].text).toContain("requested workspace");
    expect(result.content[0].text).not.toContain("granted the required scope");
  });

  it("propagates cancellation rather than continuing discovery", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      }),
    );
    await expect(invoke({ name_filter: "example" }, controller.signal)).rejects.toThrow("Aborted");
  });
});
