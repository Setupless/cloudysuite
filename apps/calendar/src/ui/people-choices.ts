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
  // A colleague's own address finds the colleague instead.
  const address = addresses && parseEmailAddress(wanted);
  const offered =
    address &&
    !skip.has(address) &&
    !colleagues.some((person) => person.email === address)
      ? address
      : null;
  const unfinished = addresses !== null && !address && wanted.includes("@");
  const [first] = people;
  const onEnter: Choice | null = first
    ? { kind: "person", person: first }
    : offered && !addresses?.refused
      ? { kind: "address", address: offered }
      : null;
  return { wanted, people, offered, unfinished, onEnter };
}
