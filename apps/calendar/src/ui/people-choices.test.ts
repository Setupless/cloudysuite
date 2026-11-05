import { expect, test } from "bun:test";
import type { UserId } from "@cloudysuite/access";
import type { EmailAddress, Person } from "../types";
import { type Choice, peopleChoices } from "./people-choices";

const colleague = (id: string, name: string, email: string): Person => ({
  id: id as UserId,
  name,
  email,
});
const BOJO = colleague("bojo", "Bo Jones", "bojo@example.com");
const JO = colleague("jo", "Jo Okafor", "jo@example.com");
const COLLEAGUES = [BOJO, JO];
const NOBODY = new Set<string>();
const BY_ADDRESS = { refused: false };
const address = (text: string): Choice => ({
  kind: "address",
  address: text as EmailAddress,
});

const onEnter = (
  text: string,
  skip: ReadonlySet<string> = NOBODY,
  addresses: { refused: boolean } | null = BY_ADDRESS,
) => peopleChoices(text, COLLEAGUES, skip, addresses).onEnter;

test("Enter on a full address inside a colleague's address invites that address", () => {
  expect(onEnter("o@example.com")).toEqual(address("o@example.com"));
  expect(onEnter(" O@Example.com ")).toEqual(address("o@example.com"));
});

test("Enter on a colleague's own address chooses them, before anyone it's inside", () => {
  expect(onEnter("jo@example.com")).toEqual({ kind: "person", person: JO });
  expect(onEnter("jo@example.com", NOBODY, null)).toEqual({
    kind: "person",
    person: JO,
  });
  // Already chosen, so Enter chooses nobody else in their place.
  expect(onEnter("jo@example.com", new Set([JO.id]))).toBeNull();
});

test("Enter on part of a name or an address chooses the first colleague", () => {
  expect(onEnter("jo")).toEqual({ kind: "person", person: BOJO });
  expect(onEnter("jo@example")).toEqual({ kind: "person", person: BOJO });
  expect(onEnter("nobody")).toBeNull();
});

test("Enter invites no address that's already on the list, or can't be emailed", () => {
  expect(onEnter("dana@partner.example.org")).toEqual(
    address("dana@partner.example.org"),
  );
  expect(
    onEnter("dana@partner.example.org", new Set(["dana@partner.example.org"])),
  ).toBeNull();
  expect(onEnter("dana@partner.example.org", NOBODY, { refused: true })).toBe(
    null,
  );
  expect(onEnter("dana@partner.example.org", NOBODY, null)).toBeNull();
});
