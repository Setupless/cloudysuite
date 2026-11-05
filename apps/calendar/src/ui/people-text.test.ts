import { expect, test } from "bun:test";
import type { CalendarId, UserId } from "@cloudysuite/access";
import type { Answer, Attendee, Organiser } from "../types";
import { comingLine, peopleSummary } from "./people-text";

const ME = "me" as UserId;
const person = (userId: string, name: string, answer: Answer): Attendee => ({
  kind: "colleague",
  userId: userId as UserId,
  name,
  answer,
});
const people = [
  person("me", "Sam Rivera", "needsAnswer"),
  person("b", "Bob Lee", "yes"),
  person("c", "Carol Diaz", "yes"),
  person("d", "Dan Wu", "maybe"),
];
const maya: Organiser = {
  kind: "colleague",
  userId: "maya" as UserId,
  name: "Maya Chen",
  calendarId: "c1" as CalendarId,
};

test("the card says who invited whom, and how they answered", () => {
  expect(peopleSummary({ organiser: maya, people }, ME)).toBe(
    "Maya Chen invited you and 3 others. 2 going, 1 maybe, 1 not replied.",
  );
  expect(
    peopleSummary(
      {
        organiser: { kind: "madeHere", userId: ME, name: "Sam Rivera" },
        people: people.slice(1),
      },
      ME,
    ),
  ).toBe("You invited 3 people. 2 going, 1 maybe.");
  expect(peopleSummary({ organiser: maya, people: [] }, ME)).toBeNull();
});

test("Today's next event names who else is going and who hasn't replied", () => {
  expect(
    comingLine([...people, person("e", "Eve Ng", "needsAnswer")], ME),
  ).toBe("Bob Lee and Carol Diaz are going. Eve Ng hasn't replied.");
  expect(
    comingLine(
      ["a", "b", "c", "d", "e"].map((id) =>
        person(id, id.toUpperCase(), "yes"),
      ),
      ME,
    ),
  ).toBe("A, B, C and 2 others are going.");
  expect(comingLine([person("d", "Dan Wu", "no")], ME)).toBeNull();
});
