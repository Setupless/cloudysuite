import {
  type BoardId,
  isBanned,
  TEAM_BOARD_COLOURS,
  type UserId,
} from "@cloudysuite/access";
import { and, asc, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { boardAccess, boards, user } from "../../../src/db/schema";
import type { BoardEntry, Member, Person } from "./types";

// Kept on every task the person adds or is given, so it can't be a whole page long.
const MAX_PERSON_NAME_LENGTH = 100;

export const personOf = (row: { id: UserId; name: string }): Person => ({
  id: row.id,
  name: row.name.slice(0, MAX_PERSON_NAME_LENGTH),
});

// Every board this person is on. Their own board is named after them, and it's in the
// list only once it's been made.
export async function readMyBoards(
  database: D1Database,
  me: { id: UserId; name: string },
): Promise<BoardEntry[]> {
  const rows = await drizzle(database)
    .select({
      id: boards.id,
      kind: boards.kind,
      name: boards.name,
      colour: boards.colour,
      role: boardAccess.role,
    })
    .from(boardAccess)
    .innerJoin(boards, eq(boards.id, boardAccess.boardId))
    .where(eq(boardAccess.userId, me.id))
    .orderBy(asc(boards.name), asc(boards.id));
  return rows.map((row) => ({ ...row, name: row.name ?? me.name }));
}

// Those who can be given a task on this board: on it, with any role, and not suspended.
export async function readMembers(
  database: D1Database,
  boardId: BoardId,
): Promise<Member[]> {
  const rows = await drizzle(database)
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: boardAccess.role,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(boardAccess)
    .innerJoin(user, eq(user.id, boardAccess.userId))
    .where(eq(boardAccess.boardId, boardId))
    .orderBy(asc(user.name), asc(user.id));
  return rows
    .filter((row) => !isBanned(row))
    .map(({ banned: _banned, banExpires: _banExpires, ...member }) => member);
}

export async function findMember(
  database: D1Database,
  boardId: BoardId,
  userId: UserId,
): Promise<Person | null> {
  const [row] = await drizzle(database)
    .select({
      id: user.id,
      name: user.name,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(boardAccess)
    .innerJoin(user, eq(user.id, boardAccess.userId))
    .where(
      and(eq(boardAccess.boardId, boardId), eq(boardAccess.userId, userId)),
    );
  return row && !isBanned(row) ? personOf(row) : null;
}

export async function createTeam(
  database: D1Database,
  me: UserId,
  name: string,
): Promise<BoardId> {
  const db = drizzle(database);
  const [existing] = await db
    .select({ total: count() })
    .from(boards)
    .where(eq(boards.kind, "team"));
  const id = crypto.randomUUID() as BoardId;
  await db.batch([
    db.insert(boards).values({
      id,
      kind: "team",
      name,
      colour:
        TEAM_BOARD_COLOURS[
          (existing?.total ?? 0) % TEAM_BOARD_COLOURS.length
        ] ?? 1,
    }),
    db.insert(boardAccess).values({ boardId: id, userId: me, role: "manager" }),
  ]);
  return id;
}
