import type { UserId } from "@cloudysuite/access";
import type { Answer, Attendee, GivenAnswer, Occurrence } from "../types";

export const ANSWER_NAMES: Record<Answer, string> = {
  yes: "Going",
  maybe: "Maybe",
  no: "Not going",
  needsAnswer: "Not replied",
};

export const ANSWER_BUTTONS: Record<GivenAnswer, string> = {
  yes: "Yes",
  maybe: "Maybe",
  no: "No",
};

const IN_ORDER: Answer[] = ["yes", "maybe", "no", "needsAnswer"];

const counted = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count} ${many}`;

// "Maya Chen, Jo Okafor and 2 others"
function namesOf(people: readonly Attendee[]): string {
  const names = people.slice(0, 3).map((person) => person.name);
  const rest = people.length - names.length;
  if (rest > 0) names.push(counted(rest, "other", "others"));
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function organiserOf(event: Pick<Occurrence, "organiser">, me: UserId) {
  const { organiser } = event;
  if (organiser.kind === "madeHere" && organiser.userId === me) return "You";
  if (organiser.kind === "invitation") return organiser.name ?? organiser.email;
  return organiser.name ?? "The organiser";
}

// "Maya Chen invited you and 3 others. 2 going, 1 maybe, 1 not replied."
export function peopleSummary(
  event: Pick<Occurrence, "organiser" | "people">,
  me: UserId,
): string | null {
  const { people } = event;
  if (people.length === 0) return null;
  const by = organiserOf(event, me);
  const others = people.filter((person) => person.userId !== me).length;
  const invited = people.some((person) => person.userId === me)
    ? others === 0
      ? `${by} invited you.`
      : `${by} invited you and ${counted(others, "other", "others")}.`
    : `${by} invited ${counted(people.length, "person", "people")}.`;
  const answers = IN_ORDER.flatMap((answer) => {
    const count = people.filter((person) => person.answer === answer).length;
    return count > 0 ? [`${count} ${ANSWER_NAMES[answer].toLowerCase()}`] : [];
  });
  return `${invited} ${answers.join(", ")}.`;
}

// Today's next event says who else is coming and who hasn't replied.
export function comingLine(
  people: readonly Attendee[],
  me: UserId,
): string | null {
  const others = people.filter((person) => person.userId !== me);
  const going = others.filter((person) => person.answer === "yes");
  const waiting = others.filter((person) => person.answer === "needsAnswer");
  const lines = [
    going.length > 0 &&
      `${namesOf(going)} ${going.length === 1 ? "is" : "are"} going.`,
    waiting.length > 0 &&
      `${namesOf(waiting)} ${waiting.length === 1 ? "hasn't" : "haven't"} replied.`,
  ].filter(Boolean);
  return lines.length > 0 ? lines.join(" ") : null;
}
