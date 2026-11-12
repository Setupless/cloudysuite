import { type BoardId, readOthers, type UserId } from "@cloudysuite/access";
import { askEach, matchesWords, type SearchTerm } from "@cloudysuite/search";
import type { BoardClient } from "./client";
import {
  readBoardIdsOf,
  readMembers,
  readMyBoards,
  readSharingWith,
} from "./directory";
import { inSearchOrder } from "./order";
import type {
  BoardEntry,
  Colleague,
  PeopleSections,
  PersonTasks,
  SearchPlace,
  TaskHit,
  TaskSearchAnswer,
} from "./types";

const RESULTS_SHOWN = 100;
const PEOPLE_SHOWN = 8;

export type OpenBoard = (boardId: BoardId) => Promise<BoardClient>;

type Searcher = { id: UserId; name: string };

const byName = (one: Colleague, other: Colleague) =>
  one.name.localeCompare(other.name) || one.id.localeCompare(other.id);

const boardOf = ({ role: _role, ...board }: BoardEntry) => board;

// Each word must start a word of their name, as in the assignee picker.
function matching(people: readonly Colleague[], terms: readonly SearchTerm[]) {
  const typed = terms.join(" ");
  return people
    .filter((person) => matchesWords(typed, person.name))
    .sort(byName)
    .slice(0, PEOPLE_SHOWN);
}

async function peopleFor(
  database: D1Database,
  me: UserId,
  boards: readonly BoardEntry[],
  place: SearchPlace,
  terms: readonly SearchTerm[],
): Promise<PeopleSections> {
  const colleagues = await readOthers(database, me);
  const board =
    place.kind === "board"
      ? boards.find(
          (entry) => entry.id === place.boardId && entry.kind === "team",
        )
      : undefined;
  if (board) {
    const members = (await readMembers(database, board.id)).filter(
      (member) => !member.suspended,
    );
    const onBoard = new Set(members.map((member) => member.id));
    return {
      kind: "board",
      board: { id: board.id, name: board.name },
      members: matching(
        members.map(({ id, name, email }) => ({ id, name, email })),
        terms,
      ),
      others: matching(
        colleagues.filter((person) => !onBoard.has(person.id)),
        terms,
      ),
    };
  }
  const sharing = await readSharingWith(database, me);
  return {
    kind: "mine",
    shared: matching(
      colleagues.filter((person) => sharing.has(person.id)),
      terms,
    ),
    others: matching(
      colleagues.filter((person) => !sharing.has(person.id)),
      terms,
    ),
  };
}

// Every board the person is on, their private tasks included, and only those.
export async function searchBoards(
  database: D1Database,
  person: Searcher,
  open: OpenBoard,
  terms: SearchTerm[],
  place: SearchPlace,
): Promise<Extract<TaskSearchAnswer, { status: "found" }>> {
  const boards = await readMyBoards(database, person);
  const [{ answers, missing }, people] = await Promise.all([
    askEach(boards, async (entry) => {
      const found = await (await open(entry.id)).search(terms);
      const board = boardOf(entry);
      return {
        more: found.more,
        tasks: found.tasks.map((task): TaskHit => ({ ...task, board })),
      };
    }),
    peopleFor(database, person.id, boards, place, terms),
  ]);
  const sorted = answers.flatMap((answer) => answer.tasks).sort(inSearchOrder);
  return {
    status: "found",
    tasks: sorted.slice(0, RESULTS_SHOWN),
    more:
      answers.some((answer) => answer.more) || sorted.length > RESULTS_SHOWN,
    people,
    unreachable: missing,
  };
}

// Only the team boards both are on, so it shows nothing the viewer can't already see.
export async function tasksOfPerson(
  database: D1Database,
  viewer: Searcher,
  open: OpenBoard,
  them: Colleague,
): Promise<PersonTasks> {
  const theirs = await readBoardIdsOf(database, them.id);
  const shared = (await readMyBoards(database, viewer)).filter(
    (entry) => entry.kind === "team" && theirs.has(entry.id),
  );
  const { answers, missing } = await askEach(shared, async (entry) => {
    const tasks = await (await open(entry.id)).listOpenFor(them.id);
    const board = boardOf(entry);
    return tasks.map((task): TaskHit => ({ ...task, board }));
  });
  return {
    person: them,
    tasks: answers.flat().sort(inSearchOrder),
    unreachable: missing,
  };
}
