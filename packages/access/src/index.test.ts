import type { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import type { DriveId, MailboxId, UserId } from "../../../src/db/schema";
import { createTestDatabase } from "../../../src/db/test-database";
import {
  checkDriveAccess,
  checkMailboxAccess,
  type DriveGrant,
  type MailboxGrant,
  parseDriveId,
  parseMailboxId,
} from "./index";

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

const marketing = "8b3f4e30-ac2d-4f90-9e77-2c3d4e5f6071" as DriveId;
const finance = "9c405f41-bd3e-4a01-8f88-3d4e5f607182" as DriveId;

function addDrives() {
  for (const id of [marketing, finance]) {
    sqlite.run(
      "INSERT INTO drives (id, kind, name, colour) VALUES (?, 'team', ?, 1)",
      [id, id],
    );
  }
  sqlite.run(
    "INSERT INTO drive_access (drive_id, user_id, role) VALUES (?, ?, 'manager'), (?, ?, 'member')",
    [marketing, alice, finance, alice],
  );
}

test("someone on a drive's list gets a grant with their role", async () => {
  addDrives();
  const managed = await checkDriveAccess(d1, alice, marketing);
  if (!managed.allowed) throw new Error("expected access");
  expect(managed.grant.userId).toBe(alice);
  expect(managed.grant.driveId).toBe(marketing);
  expect(managed.grant.role).toBe("manager");
  const joined = await checkDriveAccess(d1, alice, finance);
  if (!joined.allowed) throw new Error("expected access");
  expect(joined.grant.role).toBe("member");
});

test("someone not on a drive's list, or a drive that doesn't exist, is refused", async () => {
  addDrives();
  expect(await checkDriveAccess(d1, bob, marketing)).toEqual({
    allowed: false,
  });
  const missing = "00000000-0000-4000-8000-000000000000" as DriveId;
  expect(await checkDriveAccess(d1, alice, missing)).toEqual({
    allowed: false,
  });
});

test("a banned person is refused a drive until the ban ends", async () => {
  addDrives();
  for (const expires of [null, Date.now() + 60_000]) {
    banAlice(expires);
    expect(await checkDriveAccess(d1, alice, marketing)).toEqual({
      allowed: false,
    });
  }
  banAlice(Date.now() - 60_000);
  expect((await checkDriveAccess(d1, alice, marketing)).allowed).toBe(true);
});

test("a drive's grant cannot be built by hand, copied, or passed as a mailbox's", async () => {
  addDrives();
  const access = await checkDriveAccess(d1, alice, finance);
  if (!access.allowed) throw new Error("expected access");
  const { grant } = access;

  // @ts-expect-error A grant only comes from checkDriveAccess.
  const forged: DriveGrant = {
    userId: alice,
    driveId: marketing,
    role: "manager",
  };
  // @ts-expect-error A copy with changed values is not a grant.
  const copied: DriveGrant = { ...grant, role: "manager" };
  // @ts-expect-error A drive's grant is not a mailbox's.
  const crossed: MailboxGrant = grant;

  expect(forged).not.toBeInstanceOf(grant.constructor);
  expect(copied).not.toBeInstanceOf(grant.constructor);
  expect(crossed).toBe(grant);
  expect(() => {
    // @ts-expect-error A grant is read-only.
    grant.role = "manager";
  }).toThrow();
  const Grant = grant.constructor as new (...values: unknown[]) => DriveGrant;
  expect(() => new Grant(alice, marketing, "manager")).toThrow();
  expect(() => new Grant(Symbol(), alice, marketing, "manager")).toThrow();
});

test("removing a person keeps their personal drive and its count, with no owner", () => {
  sqlite.run(
    "INSERT INTO drives (id, kind, name, colour, owner_id, used_bytes) VALUES (?, 'personal', 'My files', 1, ?, 500)",
    [marketing, alice],
  );
  sqlite.run(
    "INSERT INTO drive_access (drive_id, user_id, role) VALUES (?, ?, 'manager')",
    [marketing, alice],
  );
  sqlite.run("DELETE FROM user WHERE id = ?", [alice]);
  expect(
    sqlite
      .query("SELECT owner_id, used_bytes FROM drives WHERE id = ?")
      .get(marketing),
  ).toEqual({ owner_id: null, used_bytes: 500 });
  expect(
    sqlite
      .query("SELECT count(*) AS rows FROM drive_access WHERE drive_id = ?")
      .get(marketing),
  ).toEqual({ rows: 0 });
});

test("a team drive can't have an owner, and a person can have only one personal drive", () => {
  expect(() =>
    sqlite.run(
      "INSERT INTO drives (id, kind, name, colour, owner_id) VALUES (?, 'team', 'x', 1, ?)",
      [marketing, alice],
    ),
  ).toThrow();
  sqlite.run(
    "INSERT INTO drives (id, kind, name, colour, owner_id) VALUES (?, 'personal', 'My files', 1, ?)",
    [marketing, alice],
  );
  expect(() =>
    sqlite.run(
      "INSERT INTO drives (id, kind, name, colour, owner_id) VALUES (?, 'personal', 'My files', 1, ?)",
      [finance, alice],
    ),
  ).toThrow();
});

test("a drive's colour stays inside the six team colours", () => {
  expect(() =>
    sqlite.run(
      "INSERT INTO drives (id, kind, name, colour) VALUES (?, 'team', 'x', 7)",
      [marketing],
    ),
  ).toThrow();
});

test("parseDriveId accepts only a lowercase uuid", () => {
  expect(parseDriveId(marketing)).toBe(marketing);
  expect(parseDriveId("../other")).toBeNull();
  expect(parseDriveId(marketing.toUpperCase())).toBeNull();
});
