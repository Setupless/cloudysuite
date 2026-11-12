import type { BoardId, UserId } from "@cloudysuite/access";
import { askEach } from "@cloudysuite/search";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { boardMoveNotices } from "../../../src/db/schema";
import { readMyBoards } from "./directory";
import type { NoticeIndexWrite } from "./store";
import type { BoardMoveNotice, MoveNotice, Person } from "./types";

// A row goes in only while the person and the board are still there, so a late write
// can't bring back what a deletion took away.
export async function writeNoticeIndex(
  database: D1Database,
  boardId: BoardId,
  writes: readonly NoticeIndexWrite[],
): Promise<void> {
  const db = drizzle(database);
  const [first, ...rest] = writes.map(({ moveId, userId, present }) =>
    present
      ? db.run(
          sql`INSERT INTO board_move_notices (user_id, board_id, move_id)
              SELECT ${userId}, ${boardId}, ${moveId}
              WHERE EXISTS (SELECT 1 FROM user WHERE id = ${userId})
                AND EXISTS (SELECT 1 FROM boards WHERE id = ${boardId})
              ON CONFLICT DO NOTHING`,
        )
      : db
          .delete(boardMoveNotices)
          .where(
            and(
              eq(boardMoveNotices.userId, userId),
              eq(boardMoveNotices.boardId, boardId),
              eq(boardMoveNotices.moveId, moveId),
            ),
          ),
  );
  if (first) await db.batch([first, ...rest]);
}

export type NoticesOf = (boardId: BoardId) => Promise<BoardMoveNotice[]>;

// Only the boards D1 says hold a note for this person, so a page with nothing to tell
// wakes no board. A board that can't answer just shows nothing this time.
export async function noticesAcrossBoards(
  database: D1Database,
  me: Person,
  noticesOf: NoticesOf,
): Promise<MoveNotice[]> {
  const indexed = await drizzle(database)
    .selectDistinct({ boardId: boardMoveNotices.boardId })
    .from(boardMoveNotices)
    .where(eq(boardMoveNotices.userId, me.id as UserId));
  if (indexed.length === 0) return [];
  const mine = new Map(
    (await readMyBoards(database, me)).map(({ role: _role, ...board }) => [
      board.id,
      board,
    ]),
  );
  const { answers } = await askEach(indexed, async ({ boardId }) =>
    (await noticesOf(boardId)).map(({ title, ...notice }): MoveNotice => {
      const stillOn = mine.get(boardId);
      return {
        ...notice,
        boardId,
        task: title !== null && stillOn ? { title, stillOn } : null,
      };
    }),
  );
  return answers.flat().sort((a, b) => b.notedAt - a.notedAt);
}
