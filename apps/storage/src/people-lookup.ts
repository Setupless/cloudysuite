import type { UserId } from "@cloudysuite/access";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { wordsOf } from "@cloudysuite/search";
import { user } from "../../../src/db/schema";
import { type OwnerFilter, shown } from "./search-query";
import type { Person } from "./types";

// D1 allows 100 bound values in a statement.
const PEOPLE_CHUNK = 90;
// A Drive object binds at most 100 values in a statement.
const MAX_OWNERS = 50;

export type People = Record<string, Person>;

export async function peopleOf(
  database: D1Database,
  ids: Iterable<string>,
): Promise<People> {
  const db = drizzle(database);
  const unique = [...new Set(ids)] as UserId[];
  const people: People = {};
  for (let start = 0; start < unique.length; start += PEOPLE_CHUNK) {
    const rows = await db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(inArray(user.id, unique.slice(start, start + PEOPLE_CHUNK)));
    for (const row of rows) people[row.id] = row;
  }
  return people;
}

const folded = (text: string) =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

// Each word must start a word of the person's name or email address, in any order,
// whatever the case or accents, the way names are searched. SQLite's LIKE folds neither
// accents nor letters outside ASCII, so the matching happens here.
export async function peopleMatching(
  database: D1Database,
  words: string,
): Promise<UserId[]> {
  const wanted = wordsOf(folded(words));
  const everyone = await drizzle(database)
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user);
  return everyone
    .filter((person) => {
      const theirs = wordsOf(folded(`${person.name} ${person.email}`));
      return wanted.every((word) =>
        theirs.some((their) => their.startsWith(word)),
      );
    })
    .map((person) => person.id);
}

// Who `owner:` means for the person searching, or what to tell them instead.
export async function ownersFor(
  database: D1Database,
  me: UserId,
  owner: OwnerFilter,
): Promise<UserId[] | { problem: string }> {
  if (owner.kind === "me") return [me];
  const owners = await peopleMatching(database, owner.words);
  if (owners.length === 0) {
    return {
      problem: `No one here is called "${shown(owner.words)}". Try part of their name or email address, or owner:me.`,
    };
  }
  if (owners.length > MAX_OWNERS) {
    return {
      problem: `Too many people match owner:${shown(owner.words)}. Add more of their name.`,
    };
  }
  return owners;
}
