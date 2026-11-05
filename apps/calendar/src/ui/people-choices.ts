import { parseEmailAddress } from "../email-address";
import type { EmailAddress, Person } from "../types";

export type Choice =
  | { kind: "person"; person: Person }
  | { kind: "address"; address: EmailAddress };

// What the people box offers for the text typed, and what Enter chooses. Addresses is
// null where only colleagues can be added. Skip holds the people and addresses already
// chosen.
export function peopleChoices(
  text: string,
  colleagues: readonly Person[],
  skip: ReadonlySet<string>,
  addresses: { refused: boolean } | null,
) {
  const wanted = text.trim().toLowerCase();
  const people =
    wanted === ""
      ? []
      : colleagues.filter(
          (person) =>
            !skip.has(person.id) &&
            (person.name.toLowerCase().includes(wanted) ||
              person.email.toLowerCase().includes(wanted)),
        );
  // A full address chooses only itself, or the colleague it belongs to, never someone
  // whose address it's part of.
  const typed = parseEmailAddress(wanted);
  const owner =
    typed && colleagues.find((person) => person.email.toLowerCase() === typed);
  const address = addresses && typed;
  const offered = address && !owner && !skip.has(address) ? address : null;
  const unfinished = addresses !== null && !address && wanted.includes("@");
  const onEnter = ((): Choice | null => {
    if (owner)
      return skip.has(owner.id) ? null : { kind: "person", person: owner };
    if (typed) {
      return offered && !addresses?.refused
        ? { kind: "address", address: offered }
        : null;
    }
    const [first] = people;
    return first ? { kind: "person", person: first } : null;
  })();
  return { wanted, people, offered, unfinished, onEnter };
}
