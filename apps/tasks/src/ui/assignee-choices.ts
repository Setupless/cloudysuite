import { matchesWords } from "@cloudysuite/search";
import type { AssigneeChoices, Colleague, Member } from "../types";

const byName = (one: Colleague, other: Colleague) =>
  one.name.localeCompare(other.name) || one.id.localeCompare(other.id);

// Each word typed must start a word of a name, as in Storage's search. Someone on the
// board is only ever in its own section.
export function assigneeChoices(
  typed: string,
  members: readonly Member[],
  colleagues: readonly Colleague[],
): AssigneeChoices {
  const onBoard = new Set(members.map((member) => member.id));
  const matching = <Person extends Colleague>(people: readonly Person[]) =>
    people.filter((person) => matchesWords(typed, person.name)).sort(byName);
  return {
    onBoard: matching(members.filter((member) => !member.suspended)),
    others: matching(colleagues.filter((person) => !onBoard.has(person.id))),
  };
}

// What a sentence calls someone, such as "Ben" for Ben Hart.
export const firstNameOf = (name: string) =>
  name.trim().split(/\s+/u)[0] || name;
