import { beforeEach, expect, test } from "bun:test";
import {
  acceptInvite,
  cancelInvite,
  createInvite,
  renewInvite,
  readInvite,
  sendInviteEmail,
} from "./invites";
import { countHashes, createKit, type Kit, PASSWORD, signIn } from "./test-kit";

let kit: Kit;

beforeEach(async () => {
  kit = await createKit();
});

async function invite(
  email = "ada@home.example",
  mailboxAddress: string | null = null,
) {
  const created = await createInvite(kit.database, {
    email,
    role: "user",
    mailboxAddress,
    invitedBy: kit.admin,
  });
  if (!created.ok) throw new Error(created.message);
  return created.token;
}

const accept = (token: string, name = "Ada") =>
  acceptInvite(kit.auth, kit.database, { token, name, password: PASSWORD });

test("the link's token is not what the database stores", async () => {
  const token = await invite();
  expect(kit.rows("SELECT token_hash FROM invites")).toEqual([
    { token_hash: expect.not.stringContaining(token) },
  ]);
});

test("a person who accepts an invite can sign in", async () => {
  const result = await accept(await invite());
  expect(result).toEqual({ ok: true, signInEmail: "ada@home.example" });
  expect((await signIn(kit, "ada@home.example")).status).toBe(200);
});

test("an invite with an address creates a personal mailbox that the person manages", async () => {
  const result = await accept(
    await invite("ada@home.example", "Ada@Example.com"),
  );
  expect(result).toEqual({ ok: true, signInEmail: "ada@example.com" });
  expect((await signIn(kit, "ada@example.com")).status).toBe(200);
  expect(
    kit.rows(
      `SELECT m.kind, m.name, a.address, a.kind AS address_kind, ma.role, u.email
       FROM mailboxes m
       JOIN addresses a ON a.mailbox_id = m.id
       JOIN mailbox_access ma ON ma.mailbox_id = m.id
       JOIN user u ON u.id = ma.user_id`,
    ),
  ).toEqual([
    {
      kind: "personal",
      name: "Ada",
      address: "ada@example.com",
      address_kind: "primary",
      role: "manager",
      email: "ada@example.com",
    },
  ]);
});

test("an invite works once", async () => {
  const token = await invite();
  expect((await accept(token)).ok).toBe(true);
  expect(await readInvite(kit.database, token)).toEqual({ state: "used" });
  const replay = await accept(token, "Mallory");
  expect(replay).toEqual({
    ok: false,
    message: expect.stringContaining("already been used"),
  });
  expect(kit.count("user")).toBe(2);
});

test("only one of many concurrent requests can use an invite", async () => {
  const token = await invite();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => accept(token, `Racer ${i}`)),
  );
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(kit.count("user")).toBe(2);
});

test("an expired invite is refused", async () => {
  const token = await invite();
  const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  expect(await readInvite(kit.database, token, later)).toEqual({
    state: "expired",
  });
  const result = await acceptInvite(
    kit.auth,
    kit.database,
    { token, name: "Ada", password: PASSWORD },
    later,
  );
  expect(result).toEqual({
    ok: false,
    message: expect.stringContaining("expired"),
  });
  expect(kit.count("user")).toBe(1);
});

test("a made-up token is refused", async () => {
  expect(await readInvite(kit.database, "made-up")).toEqual({
    state: "unknown",
  });
  expect((await accept("made-up")).ok).toBe(false);
});

test("a wrong or used invite is refused without hashing a password", async () => {
  const token = await invite();
  expect(await countHashes(kit, () => accept("made-up"))).toBe(0);
  expect(await countHashes(kit, () => accept(token))).toBe(1);
  expect(await countHashes(kit, () => accept(token))).toBe(0);
});

test("a short password leaves the link usable", async () => {
  const token = await invite();
  const refused = await acceptInvite(kit.auth, kit.database, {
    token,
    name: "Ada",
    password: "short",
  });
  expect(refused.ok).toBe(false);
  expect((await accept(token)).ok).toBe(true);
});

test("when the account can't be created, the link still works", async () => {
  const token = await invite();
  await kit.auth.api.createUser({
    body: { email: "ada@home.example", password: PASSWORD, name: "Taken" },
  });
  expect((await accept(token)).ok).toBe(false);
  expect((await readInvite(kit.database, token)).state).toBe("open");
});

test("an invite refuses an address that's taken, even by another pending invite", async () => {
  await invite("first@home.example", "team@example.com");
  const second = await createInvite(kit.database, {
    email: "second@home.example",
    role: "user",
    mailboxAddress: "TEAM@example.com",
    invitedBy: kit.admin,
  });
  expect(second).toEqual({
    ok: false,
    message: expect.stringContaining("already taken"),
  });
});

const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

async function expiredInvite(email: string, mailboxAddress: string) {
  const created = await createInvite(
    kit.database,
    { email, role: "user", mailboxAddress, invitedBy: kit.admin },
    new Date(Date.now() - EIGHT_DAYS_MS),
  );
  if (!created.ok) throw new Error(created.message);
  return created.token;
}

test("an expired invite stops holding its address, so another invite can use it", async () => {
  await expiredInvite("first@home.example", "team@example.com");
  const second = await createInvite(kit.database, {
    email: "second@home.example",
    role: "user",
    mailboxAddress: "team@example.com",
    invitedBy: kit.admin,
  });
  expect(second.ok).toBe(true);
});

test("an expired invite can't take back an address that a newer invite now holds", async () => {
  const oldToken = await expiredInvite(
    "first@home.example",
    "team@example.com",
  );
  const [{ id: oldId }] = kit.rows("SELECT id FROM invites") as [
    { id: string },
  ];
  const newToken = await invite("second@home.example", "team@example.com");

  expect(await renewInvite(kit.database, oldId)).toEqual({
    ok: false,
    message: expect.stringContaining("already taken"),
  });
  expect((await accept(oldToken)).ok).toBe(false);
  expect(await accept(newToken)).toEqual({
    ok: true,
    signInEmail: "team@example.com",
  });
  expect(await renewInvite(kit.database, oldId)).toEqual({
    ok: false,
    message: expect.stringContaining("already taken"),
  });
  expect(kit.count("addresses")).toBe(1);
});

test("Send again works for an unexpired invite that holds an address", async () => {
  await invite("first@home.example", "team@example.com");
  const [{ id }] = kit.rows("SELECT id FROM invites") as [{ id: string }];
  expect((await renewInvite(kit.database, id)).ok).toBe(true);
});

test("Send again works for an expired invite whose address is still free", async () => {
  await expiredInvite("first@home.example", "team@example.com");
  const [{ id }] = kit.rows("SELECT id FROM invites") as [{ id: string }];
  const renewed = await renewInvite(kit.database, id);
  if (!renewed.ok) throw new Error(renewed.message);
  expect((await accept(renewed.token)).ok).toBe(true);
});

test("an invite refuses an address on a domain the organisation doesn't have", async () => {
  const result = await createInvite(kit.database, {
    email: "first@home.example",
    role: "user",
    mailboxAddress: "team@other.example",
    invitedBy: kit.admin,
  });
  expect(result).toEqual({
    ok: false,
    message: expect.stringContaining("isn't one of your email domains"),
  });
});

test("an invite can't be sent to the address it would create", async () => {
  const result = await createInvite(kit.database, {
    email: "team@example.com",
    role: "user",
    mailboxAddress: "team@example.com",
    invitedBy: kit.admin,
  });
  expect(result.ok).toBe(false);
});

test("Send again replaces the link, so the old one stops working", async () => {
  const token = await invite();
  const [{ id }] = kit.rows("SELECT id FROM invites") as [{ id: string }];
  const renewed = await renewInvite(kit.database, id);
  if (!renewed.ok) throw new Error(renewed.message);
  expect((await readInvite(kit.database, token)).state).toBe("unknown");
  expect((await readInvite(kit.database, renewed.token)).state).toBe("open");
});

test("a cancelled invite stops working, and a used one can't be cancelled", async () => {
  const cancelled = await invite();
  const [{ id }] = kit.rows("SELECT id FROM invites") as [{ id: string }];
  await cancelInvite(kit.database, id);
  expect((await readInvite(kit.database, cancelled)).state).toBe("unknown");

  const used = await invite();
  await accept(used);
  const [row] = kit.rows("SELECT id FROM invites") as [{ id: string }];
  await cancelInvite(kit.database, row.id);
  expect((await readInvite(kit.database, used)).state).toBe("used");
});

test("a failed send is reported, not thrown, so the admin gets the link instead", async () => {
  const sent = await sendInviteEmail(
    {
      send: async () => {
        throw Object.assign(new Error("no"), { code: "E_SENDER_NOT_VERIFIED" });
      },
    },
    {
      to: "a@b.example",
      from: "no-reply@example.com",
      inviterName: "Boss",
      link: "x",
    },
  );
  expect(sent).toBe(false);
});

test("the email carries the link and goes to the invited address", async () => {
  const calls: unknown[] = [];
  const sent = await sendInviteEmail(
    {
      send: async (message: unknown) => {
        calls.push(message);
        return { messageId: "1" };
      },
    },
    {
      to: "a@b.example",
      from: "no-reply@example.com",
      inviterName: "Boss",
      link: "https://auth.example.com/invite/abc",
    },
  );
  expect(sent).toBe(true);
  expect(calls[0]).toMatchObject({
    to: "a@b.example",
    text: expect.stringContaining("https://auth.example.com/invite/abc"),
  });
});
