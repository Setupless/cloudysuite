import { beforeEach, expect, test } from "bun:test";
import type { MailboxId, UserId } from "../../../../src/db/schema";
import { checkMailboxAccess } from "@cloudysuite/access";
import {
  addAlias,
  addPersonalMailbox,
  createSharedMailbox,
  grantAccess,
  listMailboxes,
  removeAlias,
  revokeAccess,
} from "./mailboxes";
import { createKit, type Kit, PASSWORD } from "./test-kit";

let kit: Kit;
let member: UserId;

beforeEach(async () => {
  kit = await createKit();
  const { user } = await kit.auth.api.createUser({
    body: { email: "m@example.com", password: PASSWORD, name: "M" },
  });
  member = user.id as UserId;
});

async function sharedMailbox(
  address = "support@example.com",
): Promise<MailboxId> {
  const created = await createSharedMailbox(kit.database, {
    name: "Support",
    address,
  });
  expect(created.ok).toBe(true);
  const view = await listMailboxes(kit.database);
  return (
    view.mailboxes.find(
      (m) => m.addresses[0]?.address === address.toLowerCase(),
    ) as { id: MailboxId }
  ).id;
}

test("an address is lowercase and unique, whatever is typed", async () => {
  const id = await sharedMailbox("Support@Example.com");
  const view = await listMailboxes(kit.database);
  expect(view.mailboxes[0]?.addresses).toEqual([
    { address: "support@example.com", kind: "primary" },
  ]);
  const taken = await addAlias(kit.database, {
    mailboxId: id,
    address: "SUPPORT@example.com",
  });
  expect(taken).toEqual({
    ok: false,
    message: expect.stringContaining("already taken"),
  });
});

test("an alias can be added and removed, but a main address can't", async () => {
  const id = await sharedMailbox();
  expect(
    (
      await addAlias(kit.database, {
        mailboxId: id,
        address: "help@example.com",
      })
    ).ok,
  ).toBe(true);
  await removeAlias(kit.database, "help@example.com");
  await removeAlias(kit.database, "support@example.com");
  const view = await listMailboxes(kit.database);
  expect(view.mailboxes[0]?.addresses).toEqual([
    { address: "support@example.com", kind: "primary" },
  ]);
});

test("granting access opens the mailbox, and revoking closes it", async () => {
  const id = await sharedMailbox();
  expect((await checkMailboxAccess(kit.database, member, id)).allowed).toBe(
    false,
  );
  await grantAccess(kit.database, {
    mailboxId: id,
    userId: member,
    role: "member",
  });
  const opened = await checkMailboxAccess(kit.database, member, id);
  expect(opened.allowed && opened.grant.role).toBe("member");
  await grantAccess(kit.database, {
    mailboxId: id,
    userId: member,
    role: "manager",
  });
  const raised = await checkMailboxAccess(kit.database, member, id);
  expect(raised.allowed && raised.grant.role).toBe("manager");
  await revokeAccess(kit.database, { mailboxId: id, userId: member });
  expect((await checkMailboxAccess(kit.database, member, id)).allowed).toBe(
    false,
  );
});

test("a person's sign-in address can become their own mailbox, but nobody else's", async () => {
  const someoneElse = await addPersonalMailbox(kit.database, {
    userId: kit.admin,
    address: "m@example.com",
  });
  expect(someoneElse).toEqual({
    ok: false,
    message: expect.stringContaining("already taken"),
  });
  const own = await addPersonalMailbox(kit.database, {
    userId: member,
    address: "M@example.com",
  });
  expect(own.ok).toBe(true);
});

test("a person gets one personal mailbox", async () => {
  expect(
    (
      await addPersonalMailbox(kit.database, {
        userId: member,
        address: "mm@example.com",
      })
    ).ok,
  ).toBe(true);
  const second = await addPersonalMailbox(kit.database, {
    userId: member,
    address: "other@example.com",
  });
  expect(second).toEqual({
    ok: false,
    message: expect.stringContaining("already has a personal mailbox"),
  });
});

test("removing a member deletes no mailbox and no address", async () => {
  await addPersonalMailbox(kit.database, {
    userId: member,
    address: "mm@example.com",
  });
  kit.sqlite.run("DELETE FROM user WHERE id = ?", [member]);
  const view = await listMailboxes(kit.database);
  expect(view.mailboxes).toHaveLength(1);
  expect(view.mailboxes[0]?.access).toEqual([]);
  expect(view.mailboxes[0]?.addresses[0]?.address).toBe("mm@example.com");
});
