import type { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import type { MailboxId, UserId } from "../../../src/db/schema";
import { createTestDatabase } from "../../../src/db/test-database";
import { checkMailboxAccess, type MailboxGrant, parseMailboxId } from "./index";

const alice = "user-alice" as UserId;
const bob = "user-bob" as UserId;
const support = "6f1d2c1e-8a0b-4d7e-9c55-0a1b2c3d4e5f" as MailboxId;
const sales = "7a2e3d2f-9b1c-4e8f-8d66-1b2c3d4e5f60" as MailboxId;

let sqlite: Database;
let d1: D1Database;

beforeEach(() => {
  ({ sqlite, d1 } = createTestDatabase());
  for (const [id, email] of [
    [alice, "alice@example.com"],
    [bob, "bob@example.com"],
  ]) {
    sqlite.run("INSERT INTO user (id, name, email) VALUES (?, ?, ?)", [
      id!,
      email!,
      email!,
    ]);
  }
  for (const id of [support, sales]) {
    sqlite.run(
      "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'shared', ?)",
      [id, id],
    );
  }
  sqlite.run(
    "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, 'manager'), (?, ?, 'member')",
    [support, alice, sales, alice],
  );
});

test("a manager gets a grant with the manager role", async () => {
  const access = await checkMailboxAccess(d1, alice, support);
  if (!access.allowed) throw new Error("expected access");
  expect(access.grant.userId).toBe(alice);
  expect(access.grant.mailboxId).toBe(support);
  expect(access.grant.role).toBe("manager");
});

test("a member gets a grant with the member role", async () => {
  const access = await checkMailboxAccess(d1, alice, sales);
  if (!access.allowed) throw new Error("expected access");
  expect(access.grant.role).toBe("member");
});

test("someone with no access row is denied and gets no grant", async () => {
  expect(await checkMailboxAccess(d1, bob, support)).toEqual({
    allowed: false,
  });
});

test("access to one mailbox does not open another", async () => {
  sqlite.run("DELETE FROM mailbox_access WHERE mailbox_id = ?", [sales]);
  expect(await checkMailboxAccess(d1, alice, sales)).toEqual({
    allowed: false,
  });
});

test("a mailbox that does not exist is denied", async () => {
  const missing = "00000000-0000-4000-8000-000000000000" as MailboxId;
  expect(await checkMailboxAccess(d1, alice, missing)).toEqual({
    allowed: false,
  });
});

test("removing a user removes their access", async () => {
  sqlite.run("DELETE FROM user WHERE id = ?", [alice]);
  expect(await checkMailboxAccess(d1, alice, support)).toEqual({
    allowed: false,
  });
});

test("a grant cannot be built by hand or copied with other values", async () => {
  const access = await checkMailboxAccess(d1, alice, sales);
  if (!access.allowed) throw new Error("expected access");
  const { grant } = access;

  // @ts-expect-error A grant only comes from checkMailboxAccess.
  const forged: MailboxGrant = {
    userId: alice,
    mailboxId: support,
    role: "manager",
  };
  // @ts-expect-error A copy with changed values is not a grant.
  const copied: MailboxGrant = { ...grant, role: "manager" };

  expect(forged).not.toBeInstanceOf(grant.constructor);
  expect(copied).not.toBeInstanceOf(grant.constructor);
  expect(() => {
    // @ts-expect-error A grant is read-only.
    grant.role = "manager";
  }).toThrow();
  expect(grant.role).toBe("member");
});

test("the grant class cannot mint a grant without the access check", async () => {
  const access = await checkMailboxAccess(d1, alice, sales);
  if (!access.allowed) throw new Error("expected access");
  const Grant = access.grant.constructor as new (
    ...values: unknown[]
  ) => MailboxGrant;

  expect(() => new Grant(alice, support, "manager")).toThrow();
  expect(() => new Grant(Symbol(), alice, support, "manager")).toThrow();
  expect(() => Reflect.construct(Grant, [alice, support, "manager"])).toThrow();
  class Subclass extends Grant {}
  expect(() => new Subclass(alice, support, "manager")).toThrow();
});

const banAlice = (expires: number | null) =>
  sqlite.run("UPDATE user SET banned = 1, ban_expires = ? WHERE id = ?", [
    expires,
    alice,
  ]);

test("a banned user is denied, with or without an end date in the future", async () => {
  for (const expires of [null, Date.now() + 60_000]) {
    banAlice(expires);
    expect(await checkMailboxAccess(d1, alice, support)).toEqual({
      allowed: false,
    });
  }
});

test("a user whose ban has expired is allowed", async () => {
  banAlice(Date.now() - 60_000);
  const access = await checkMailboxAccess(d1, alice, support);
  if (!access.allowed) throw new Error("expected access");
  expect(access.grant.role).toBe("manager");
});

test.each([
  ["6f1d2c1e-8a0b-4d7e-9c55-0a1b2c3d4e5f", true],
  ["../other", false],
  ["", false],
  ["6F1D2C1E-8A0B-4D7E-9C55-0A1B2C3D4E5F", false],
])("parseMailboxId(%j) accepts: %j", (raw, ok) => {
  expect(parseMailboxId(raw) !== null).toBe(ok);
});
