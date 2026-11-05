import { expect, test } from "bun:test";
import type { UserId } from "@cloudysuite/access";
import { createTestDatabase } from "../../../../src/db/test-database";
import type { EmailAddress } from "../types";
import { colleaguesAt, readSendingFacts } from "./senders";

// An event or an email can name any number of people, and D1 binds at most 100 values
// in one statement.
function directoryOf(count: number) {
  const { sqlite, d1 } = createTestDatabase();
  sqlite.run(
    "INSERT INTO domains (name, is_primary) VALUES ('example.com', 1)",
  );
  const people = Array.from({ length: count }, (_, index) => {
    const id = `person-${index}` as UserId;
    const address = `person${index}@example.com` as EmailAddress;
    const mailbox = `mailbox-${index}`;
    sqlite.run("INSERT INTO user (id, name, email) VALUES (?, ?, ?)", [
      id,
      `Person ${index}`,
      address,
    ]);
    sqlite.run(
      "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'personal', ?)",
      [mailbox, address],
    );
    sqlite.run(
      "INSERT INTO addresses (address, domain, mailbox_id, kind) VALUES (?, 'example.com', ?, 'primary')",
      [address, mailbox],
    );
    sqlite.run(
      "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, 'manager')",
      [mailbox, id],
    );
    return { id, address };
  });
  return { d1, people };
}

test("the addresses of more than a hundred colleagues are found at once", async () => {
  const { d1, people } = directoryOf(250);
  const [organiser, ...colleagues] = people;

  const facts = await readSendingFacts(
    d1,
    organiser!.id,
    colleagues.map((one) => one.id),
  );
  expect(facts.organiser).toBe(organiser!.address);
  expect(facts.colleagues.size).toBe(249);
  expect(facts.colleagues.get(colleagues[248]!.id)).toBe(
    colleagues[248]!.address,
  );
});

test("whose mailbox each of more than a hundred addresses reaches is found at once", async () => {
  const { d1, people } = directoryOf(250);
  const found = await colleaguesAt(d1, [
    ...people.map((one) => one.address),
    "stranger@partner.example.org" as EmailAddress,
  ]);
  expect(found.size).toBe(250);
  expect(found.get(people[249]!.address)).toBe(people[249]!.id);
});
