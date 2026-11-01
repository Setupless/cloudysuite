import { expect, test } from "bun:test";
import { createTestDatabase } from "../../../src/db/test-database";
import { recipientCandidates, resolveRecipient } from "./address";
import { MAILBOX_A, MAILBOX_B } from "./test-support";

test.each([
  ["Bob@Example.COM", ["bob@example.com"]],
  ["  bob@example.com ", ["bob@example.com"]],
  ["bob+news@example.com", ["bob+news@example.com", "bob@example.com"]],
  ["bob+a+b@example.com", ["bob+a+b@example.com", "bob@example.com"]],
  ["+news@example.com", ["+news@example.com"]],
  ["bob", []],
  ["@example.com", []],
  ["bob@", []],
  ["", []],
])("recipientCandidates(%j)", (to, expected) => {
  expect(recipientCandidates(to)).toEqual(expected);
});

function directory() {
  const { sqlite, d1 } = createTestDatabase();
  sqlite.run(
    "INSERT INTO domains (name, is_primary) VALUES ('example.com', 1)",
  );
  for (const id of [MAILBOX_A, MAILBOX_B]) {
    sqlite.run(
      "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'shared', ?)",
      [id, id],
    );
  }
  sqlite.run(
    `INSERT INTO addresses (address, domain, mailbox_id, kind) VALUES
      ('bob@example.com', 'example.com', ?, 'primary'),
      ('robert@example.com', 'example.com', ?, 'alias'),
      ('team+sales@example.com', 'example.com', ?, 'primary'),
      ('team@example.com', 'example.com', ?, 'alias')`,
    [MAILBOX_A, MAILBOX_A, MAILBOX_B, MAILBOX_A],
  );
  return d1;
}

test("a primary address, an alias, and a plus address reach the mailbox, in any case", async () => {
  const d1 = directory();
  for (const to of [
    "bob@example.com",
    "BOB@EXAMPLE.COM",
    "robert@example.com",
    "bob+shopping@example.com",
    "Robert+x@Example.com",
  ]) {
    expect(await resolveRecipient(d1, to)).toBe(MAILBOX_A);
  }
});

test("a stored address containing a plus wins over its base address", async () => {
  const d1 = directory();
  expect(await resolveRecipient(d1, "team+sales@example.com")).toBe(MAILBOX_B);
  expect(await resolveRecipient(d1, "team+other@example.com")).toBe(MAILBOX_A);
});

test("an unknown address resolves to no mailbox", async () => {
  const d1 = directory();
  expect(await resolveRecipient(d1, "nobody@example.com")).toBeNull();
  expect(await resolveRecipient(d1, "bob@other.example")).toBeNull();
  expect(await resolveRecipient(d1, "not an address")).toBeNull();
});
