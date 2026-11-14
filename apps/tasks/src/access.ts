import { env } from "cloudflare:workers";
import type { BoardId, UserId } from "@cloudysuite/access";
import { requireReadyUser } from "@cloudysuite/auth/guard";
import { assertAppOn } from "../../../src/app-on";
import { settingsFor } from "../../../src/settings";
import { openBoardAs } from "./client";
import { NO_ACCESS_MESSAGE } from "./types";
import { refusal } from "./wire";

// A server function answers on every app's hostname, so each one starts here.
export async function requireTasksUser(request: Request) {
  assertAppOn(await settingsFor(request, env.DB), "tasks");
  return requireReadyUser(request);
}

// After `requireTasksUser`. The object then refuses a change from anyone with only
// Can view, in the call that would make it.
export async function openBoardFor(userId: UserId, boardId: BoardId) {
  const board = await openBoardAs(env, userId, boardId);
  if (!board) throw refusal(403, NO_ACCESS_MESSAGE);
  return board;
}
