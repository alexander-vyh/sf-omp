/* SPDX-License-Identifier: Apache-2.0 */
/** Workspace routing and continuation for the read-only channel directory. */
import { getTeamId, listApprovedTeamIds, slackApi } from "./api.ts";
import { ENV_TEAM_ID, type ApiResult, type ConversationsListResponse } from "./types.ts";

const CURSOR_PREFIX = "sf-slack:";

interface DirectoryCursor {
  teams: string[];
  cursor?: string;
}

interface DirectoryParams {
  types: string;
  limit: number;
  cursor?: string;
}

function encodeCursor(state: DirectoryCursor): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(state)).toString("base64url");
}

function decodeCursor(cursor: string): DirectoryCursor | undefined {
  try {
    const value = JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as Partial<DirectoryCursor> | null;
    if (
      !value ||
      !Array.isArray(value.teams) ||
      value.teams.length === 0 ||
      !value.teams.every((id) => typeof id === "string" && /^T[A-Z0-9]+$/.test(id)) ||
      (value.cursor !== undefined && typeof value.cursor !== "string")
    ) {
      return undefined;
    }
    return { teams: value.teams, cursor: value.cursor };
  } catch {
    return undefined;
  }
}

/** A continuation includes its workspace, so Slack cursors cannot cross teams. */
export async function listChannelDirectory(
  token: string,
  params: DirectoryParams,
  signal?: AbortSignal,
): Promise<ApiResult<ConversationsListResponse>> {
  const explicitTeam = process.env[ENV_TEAM_ID]?.trim();
  if (explicitTeam && !/^T[A-Z0-9]+$/.test(explicitTeam)) {
    return {
      ok: false,
      error: "invalid_arguments",
      messages: ["SLACK_TEAM_ID must select a workspace ID (T…), not an enterprise ID (E…)."],
    };
  }

  let state: DirectoryCursor | undefined;
  if (params.cursor?.startsWith(CURSOR_PREFIX)) {
    state = decodeCursor(params.cursor);
    if (!state || (explicitTeam && state.teams.some((id) => id !== explicitTeam))) {
      return { ok: false, error: "invalid_cursor" };
    }
  } else if (getTeamId().startsWith("E")) {
    if (params.cursor) return { ok: false, error: "invalid_cursor" };
    const approved = await listApprovedTeamIds(token, signal);
    if (approved.ok === false) return approved;
    state = { teams: approved.data };
  }

  if (!state) {
    const result = await slackApi<ConversationsListResponse>(
      "conversations.list",
      token,
      { ...params, exclude_archived: true },
      signal,
    );
    if (
      result.ok === true ||
      explicitTeam ||
      params.cursor ||
      (result.error !== "team_access_not_granted" && result.error !== "missing_argument")
    ) {
      return result;
    }
    const approved = await listApprovedTeamIds(token, signal);
    if (approved.ok === false) return approved;
    state = { teams: approved.data };
  }

  const result = await slackApi<ConversationsListResponse>(
    "conversations.list",
    token,
    {
      types: params.types,
      limit: params.limit,
      cursor: state.cursor,
      team_id: state.teams[0],
      exclude_archived: true,
    },
    signal,
  );
  if (result.ok === false) return result;
  const slackCursor = result.data.response_metadata?.next_cursor;
  const remaining = slackCursor ? state.teams : state.teams.slice(1);
  return {
    ok: true,
    data: {
      ...result.data,
      response_metadata: {
        ...result.data.response_metadata,
        next_cursor: remaining.length
          ? encodeCursor({ teams: remaining, cursor: slackCursor || undefined })
          : "",
      },
    },
  };
}
