import type { UserId } from "@cloudysuite/access";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { user } from "../../../src/db/schema";
import type { Person } from "./types";

// D1 allows 100 bound values in a statement.
const PEOPLE_CHUNK = 90;

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
