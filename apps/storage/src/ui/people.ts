import type { People } from "../functions";

// Removing a person leaves what they added, and their name goes with their account.
export const personOf = (people: People, id: string) =>
  people[id] ?? { name: "Someone who left", email: id };
