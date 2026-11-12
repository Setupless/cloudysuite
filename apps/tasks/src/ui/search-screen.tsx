import { type BoardId, parseBoardId } from "@cloudysuite/access";
import { Avatar, Notice, useHydrated } from "@cloudysuite/ui";
import { IconCheck } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { searchQuery } from "../queries";
import { parseTaskSearch } from "../search-query";
import type { Colleague, PeopleSections, PlainDate, TaskHit } from "../types";
import { dayOnDevice } from "./dates";
import { BoardName, DueLabel, FOCUS } from "./parts";
import { PageHeading, useToday } from "./task-page";

const ROW = `mx-2 flex min-h-11 items-center gap-3 rounded px-2.5 py-2 hover:bg-field ${FOCUS}`;

const unreachableText = (count: number) =>
  `We couldn't search ${count === 1 ? "one of your boards" : `${count} of your boards`}, so some tasks may be missing. Try again in a moment.`;

const Hint = ({ children }: { children: ReactNode }) => (
  <p className="px-4 text-sm text-secondary">{children}</p>
);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="pb-2">
      <h2 className="px-4 pt-3 pb-1 text-xs font-semibold text-secondary">
        {title}
      </h2>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

// A private task opens on My tasks, which lists it while it's open or done today. One
// done before then opens on the person's own board, which lists every one.
function TaskResult({ task, today }: { task: TaskHit; today: PlainDate }) {
  const done = task.status === "done";
  const onMyTasks =
    task.board.kind === "personal" &&
    (!done || (task.doneAt !== null && dayOnDevice(task.doneAt) === today));
  const body = (
    <>
      <span
        aria-hidden
        className={`flex size-[18px] flex-none items-center justify-center rounded-full border-[1.5px] ${done ? "border-accent bg-accent text-on-accent" : "border-secondary"}`}
      >
        {done && <IconCheck size={12} stroke={3} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          dir="auto"
          className={`truncate text-sm ${done ? "text-secondary line-through" : ""}`}
        >
          {task.title}
        </span>
        <span className="flex min-w-0 items-center gap-2.5 text-xs text-secondary">
          {done && <span className="sr-only">Done.</span>}
          {task.status === "doing" && (
            <span className="font-medium text-accent">Doing</span>
          )}
          <span className="min-w-0 sm:hidden">
            <BoardName board={task.board} />
          </span>
        </span>
      </span>
      <span className="flex w-36 text-xs max-sm:hidden">
        <BoardName board={task.board} />
      </span>
      <span className="flex w-[4.75rem] justify-end text-right text-xs sm:w-24">
        <DueLabel due={task.due} today={today} />
      </span>
    </>
  );
  return (
    <li>
      {onMyTasks ? (
        <Link to="/tasks" search={{ task: task.id }} className={ROW}>
          {body}
        </Link>
      ) : (
        <Link
          to="/tasks/boards/$boardId"
          params={{ boardId: task.board.id }}
          search={{ task: task.id }}
          className={ROW}
        >
          {body}
        </Link>
      )}
    </li>
  );
}

// Never says how many tasks someone has, because that would show a colleague's workload.
function PersonResult({
  person,
  board,
}: {
  person: Colleague;
  board: BoardId | null;
}) {
  const body = (
    <>
      <Avatar person={person} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span dir="auto" className="truncate text-sm font-medium">
          {person.name}
        </span>
        <span className="truncate text-xs text-secondary">{person.email}</span>
      </span>
    </>
  );
  return (
    <li>
      {board ? (
        <Link
          to="/tasks/boards/$boardId"
          params={{ boardId: board }}
          search={{ person: person.id }}
          className={ROW}
        >
          {body}
        </Link>
      ) : (
        <Link
          to="/tasks/people/$userId"
          params={{ userId: person.id }}
          className={ROW}
        >
          {body}
        </Link>
      )}
    </li>
  );
}

function People({ people }: { people: PeopleSections }) {
  const board = people.kind === "board" ? people.board : null;
  const [first, firstTitle] =
    people.kind === "board"
      ? [people.members, `On ${people.board.name}`]
      : [people.shared, "On your boards"];
  const row = (person: Colleague) => (
    <PersonResult key={person.id} person={person} board={board?.id ?? null} />
  );
  return (
    <>
      {first.length > 0 && (
        <Section title={firstTitle}>{first.map(row)}</Section>
      )}
      {people.others.length > 0 && (
        <Section title="Others in your organisation">
          {people.others.map(row)}
        </Section>
      )}
    </>
  );
}

function LoadingRows() {
  return (
    <div aria-busy className="flex flex-col gap-3 px-4 pt-3">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-9 animate-pulse rounded bg-field" />
      ))}
    </div>
  );
}

function Results({ text, board }: { text: string; board: BoardId | null }) {
  const parsed = parseTaskSearch(text);
  const query = useQuery({ ...searchQuery(text, board), enabled: parsed.ok });
  const today = useToday();

  if (!parsed.ok) return <Hint>{parsed.problem}</Hint>;
  if (query.error) {
    return (
      <div className="px-4">
        <Notice tone="danger">{query.error.message}</Notice>
      </div>
    );
  }
  if (!query.data) return <LoadingRows />;
  if (query.data.status === "problem") return <Hint>{query.data.problem}</Hint>;
  const { tasks, people, more, unreachable } = query.data;
  const open = tasks.filter((task) => task.status !== "done");
  const done = tasks.filter((task) => task.status === "done");
  const nobody =
    people.others.length +
      (people.kind === "board" ? people.members : people.shared).length ===
    0;

  return (
    <>
      {unreachable > 0 && (
        <div className="px-4 pb-2.5">
          <Notice tone="info">{unreachableText(unreachable)}</Notice>
        </div>
      )}
      {tasks.length === 0 && nobody ? (
        unreachable === 0 && (
          <Hint>
            Nothing matched your search. Check the spelling, or take a word out.
            Search looks at each task's title and notes, and at people's names.
          </Hint>
        )
      ) : (
        <>
          <People people={people} />
          {open.length > 0 && (
            <Section title="Still to do">
              {open.map((task) => (
                <TaskResult key={task.id} task={task} today={today} />
              ))}
            </Section>
          )}
          {done.length > 0 && (
            <Section title="Done">
              {done.map((task) => (
                <TaskResult key={task.id} task={task} today={today} />
              ))}
            </Section>
          )}
          {more && (
            <p className="px-4 pt-1 text-[13px] text-secondary">
              These are the closest matches. Add another word to narrow them
              down.
            </p>
          )}
        </>
      )}
    </>
  );
}

export function SearchScreen({
  text,
  board,
}: {
  text: string;
  // The board search started from, whose members come first.
  board: string | undefined;
}) {
  // Due dates read from the device's own day, which only the browser knows.
  const hydrated = useHydrated();
  return (
    <div className="min-h-[calc(100dvh-3.25rem)] pb-6 *:max-w-[912px]">
      <PageHeading title="Search" canAdd={null} onAdd={() => {}} />
      {hydrated ? (
        <Results text={text} board={board ? parseBoardId(board) : null} />
      ) : (
        <LoadingRows />
      )}
    </div>
  );
}
