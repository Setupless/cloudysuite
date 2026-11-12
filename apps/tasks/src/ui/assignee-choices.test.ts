import { expect, test } from "bun:test";
import type { UserId } from "@cloudysuite/access";
import type { Colleague, Member } from "../types";
import { assigneeChoices, firstNameOf } from "./assignee-choices";

const person = (id: string, name: string): Colleague => ({
  id: id as UserId,
  name,
  email: `${id}@example.com`,
});
const member = (id: string, name: string): Member => ({
  ...person(id, name),
  role: "viewer",
  joinedAt: 0,
});

const members = [member("maya", "Maya Ortiz"), member("ana", "Ána Lind")];
const everyone = [
  person("ben", "Ben Hart"),
  person("maya", "Maya Ortiz"),
  person("bea", "Beatrix Ortega"),
];
const names = (people: readonly Colleague[]) => people.map((one) => one.name);

test("the board's members come first, and nobody is listed twice", () => {
  const choices = assigneeChoices("", members, everyone);
  expect(names(choices.onBoard)).toEqual(["Ána Lind", "Maya Ortiz"]);
  expect(names(choices.others)).toEqual(["Beatrix Ortega", "Ben Hart"]);
});

test("each word typed must start a word of the name, in any order and any case", () => {
  const ort = assigneeChoices("ORT", members, everyone);
  expect(names(ort.onBoard)).toEqual(["Maya Ortiz"]);
  expect(names(ort.others)).toEqual(["Beatrix Ortega"]);

  expect(names(assigneeChoices("hart b", members, everyone).others)).toEqual([
    "Ben Hart",
  ]);
  expect(names(assigneeChoices("art", members, everyone).others)).toEqual([]);
  expect(names(assigneeChoices("ana", members, everyone).onBoard)).toEqual([
    "Ána Lind",
  ]);
});

test("a sentence names someone by their first name", () => {
  expect(firstNameOf("Ben Hart")).toBe("Ben");
  expect(firstNameOf("  Cher ")).toBe("Cher");
});
