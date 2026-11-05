// Workers allows six open connections at once, and the rest of the request needs some.
const OBJECTS_AT_ONCE = 5;
// Long enough for an object that has to wake first, short enough that stuck objects can't
// leave the page waiting with no results. It covers asking all of them, not each one.
const DEADLINE_MS = 5_000;

// Being refused means this person has no access any more, so there is nothing of theirs to
// show. An object that fails, answers after the deadline, or isn't reached by then is
// missing.
type Outcome<Answer> = { answer: Answer } | "refused" | "missing";

// What has answered by the deadline is the answer, and a later answer is dropped.
export async function askEach<Entry, Answer>(
  list: readonly Entry[],
  ask: (entry: Entry) => Promise<Answer>,
): Promise<{ answers: Answer[]; incomplete: boolean }> {
  const outcomes: Outcome<Answer>[] = list.map(() => "missing");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), DEADLINE_MS);
  });
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < list.length; index = next++) {
      try {
        const outcome = await Promise.race([
          ask(list[index]!).then((answer) => ({ answer })),
          late,
        ]);
        if (outcome === "late") return;
        outcomes[index] = outcome;
      } catch (thrown) {
        if (thrown instanceof Response && thrown.status === 403) {
          outcomes[index] = "refused";
        } else {
          console.error("Could not ask one object.", thrown);
        }
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: OBJECTS_AT_ONCE }, worker));
  } finally {
    clearTimeout(timer);
  }
  const missing = outcomes.filter((outcome) => outcome === "missing").length;
  if (missing > 0) {
    console.error(`Answered without ${missing} of ${list.length} objects.`);
  }
  return {
    answers: outcomes.flatMap((outcome) =>
      typeof outcome === "object" ? [outcome.answer] : [],
    ),
    incomplete: missing > 0,
  };
}
