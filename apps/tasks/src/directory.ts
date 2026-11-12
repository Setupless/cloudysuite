import {
  type BoardId,
  type BoardRole,
  isBanned,
  TEAM_BOARD_COLOURS,
  type UserId,
} from "@cloudysuite/access";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { boardAccess, boards, user } from "../../../src/db/schema";
import type { BoardEntry, BoardSettings, Member, Person } from "./types";

export type TeamChange = "done" | "lastManager" | "notOnIt";

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

// Everyone on the board, in the order they joined, the way a board's settings list them.
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
      joinedAt: boardAccess.createdAt,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(boardAccess)
    .innerJoin(user, eq(user.id, boardAccess.userId))
    .where(eq(boardAccess.boardId, boardId))
    .orderBy(asc(boardAccess.createdAt), asc(user.name), asc(user.id));
  return rows.map(({ banned, banExpires, joinedAt, ...member }) => ({
    ...member,
    joinedAt: joinedAt.getTime(),
    suspended: isBanned({ banned, banExpires }),
  }));
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

const isTeam = (boardId: BoardId) =>
  and(eq(boards.id, boardId), eq(boards.kind, "team"));

export async function readSettings(
  database: D1Database,
  boardId: BoardId,
  myRole: BoardRole,
): Promise<BoardSettings | null> {
  const [board] = await drizzle(database)
    .select({ id: boards.id, name: boards.name, colour: boards.colour })
    .from(boards)
    .where(isTeam(boardId));
  if (!board?.name) return null;
  return {
    board: { ...board, name: board.name },
    myRole,
    members: await readMembers(database, boardId),
  };
}

// Someone who could be added now: in the organisation and not suspended.
export async function isAddable(
  database: D1Database,
  userId: UserId,
): Promise<boolean> {
  const [row] = await drizzle(database)
    .select({ banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(eq(user.id, userId));
  return row !== undefined && !isBanned(row);
}

export async function renameTeam(
  database: D1Database,
  boardId: BoardId,
  name: string,
): Promise<void> {
  await drizzle(database).update(boards).set({ name }).where(isTeam(boardId));
}

export async function setColour(
  database: D1Database,
  boardId: BoardId,
  colour: number,
): Promise<void> {
  await drizzle(database).update(boards).set({ colour }).where(isTeam(boardId));
}

// board_access goes with it.
export async function deleteTeam(
  database: D1Database,
  boardId: BoardId,
): Promise<void> {
  await drizzle(database).delete(boards).where(isTeam(boardId));
}

// Someone already on it keeps the role they have, so adding can't demote anyone, and
// adding twice changes nothing. A person's own board is only theirs.
export async function addToTeam(
  database: D1Database,
  boardId: BoardId,
  userId: UserId,
  role: BoardRole,
): Promise<void> {
  await drizzle(database).run(
    sql`INSERT INTO board_access (board_id, user_id, role)
        SELECT ${boardId}, ${userId}, ${role} FROM boards
        WHERE id = ${boardId} AND kind = 'team'
        ON CONFLICT DO NOTHING`,
  );
}

// D1 runs two statements one after the other, so each guard sees what the other did. Two
// managers stepping down together can't leave nobody.
const isNotTheLastManager = sql`(${boardAccess.role} != 'manager' OR EXISTS (
  SELECT 1 FROM board_access AS others
  WHERE others.board_id = ${boardAccess.boardId}
    AND others.user_id != ${boardAccess.userId}
    AND others.role = 'manager'
))`;

const accessOf = (boardId: BoardId, userId: UserId) =>
  and(eq(boardAccess.boardId, boardId), eq(boardAccess.userId, userId));

async function whyNothingChanged(
  database: D1Database,
  boardId: BoardId,
  userId: UserId,
): Promise<TeamChange> {
  const [row] = await drizzle(database)
    .select({ role: boardAccess.role })
    .from(boardAccess)
    .where(accessOf(boardId, userId));
  return row ? "lastManager" : "notOnIt";
}

export async function setMemberRole(
  database: D1Database,
  boardId: BoardId,
  userId: UserId,
  role: BoardRole,
): Promise<TeamChange> {
  const changed = await drizzle(database)
    .update(boardAccess)
    .set({ role })
    .where(
      and(
        accessOf(boardId, userId),
        role === "manager" ? undefined : isNotTheLastManager,
      ),
    )
    .returning({ userId: boardAccess.userId });
  return changed.length > 0
    ? "done"
    : whyNothingChanged(database, boardId, userId);
}

// Their tasks stay on the board under their name.
export async function removeMember(
  database: D1Database,
  boardId: BoardId,
  userId: UserId,
): Promise<TeamChange> {
  const removed = await drizzle(database)
    .delete(boardAccess)
    .where(and(accessOf(boardId, userId), isNotTheLastManager))
    .returning({ userId: boardAccess.userId });
  return removed.length > 0
    ? "done"
    : whyNothingChanged(database, boardId, userId);
}
