import { beforeEach, expect, test } from "bun:test";
import type { UserId } from "../../../../src/db/schema";
import { completeReset, issueResetLink, readResetLink } from "./reset";
import { countHashes, createKit, type Kit, PASSWORD, signIn } from "./test-kit";

const NEW_PASSWORD = "a brand new password";

let kit: Kit;
let member: UserId;

beforeEach(async () => {
  kit = await createKit();
  const { user } = await kit.auth.api.createUser({
    body: { email: "m@example.com", password: PASSWORD, name: "M" },
  });
  member = user.id as UserId;
  kit.sqlite.run(
    `INSERT INTO passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up)
     VALUES ('k', 'p', ?, 'c', 0, 'singleDevice', 0)`,
    [member],
  );
  kit.sqlite.run(
    "INSERT INTO two_factor (id, secret, backup_codes, user_id) VALUES ('t', 's', 'b', ?)",
    [member],
  );
  kit.sqlite.run("UPDATE user SET two_factor_enabled = 1 WHERE id = ?", [
    member,
  ]);
});

const finish = (token: string, password = NEW_PASSWORD) =>
  completeReset(kit.auth, kit.database, { token, password });

test("a reset removes every way in and every session", async () => {
  kit.sqlite.run("UPDATE user SET two_factor_enabled = 0 WHERE id = ?", [
    member,
  ]);
  expect((await signIn(kit, "m@example.com")).status).toBe(200);
  kit.sqlite.run("UPDATE user SET two_factor_enabled = 1 WHERE id = ?", [
    member,
  ]);

  await issueResetLink(kit.database, member);

  for (const table of ["passkey", "two_factor"])
    expect(kit.count(table)).toBe(0);
  expect(
    kit.rows(`SELECT id FROM session WHERE user_id = '${member}'`),
  ).toEqual([]);
  expect((await signIn(kit, "m@example.com")).status).toBeGreaterThanOrEqual(
    400,
  );
  expect(
    kit.rows(
      `SELECT two_factor_enabled AS on_ FROM user WHERE id = '${member}'`,
    ),
  ).toEqual([{ on_: 0 }]);
});

test("the link lets the person choose a password and sign in, with no code step", async () => {
  const token = await issueResetLink(kit.database, member);
  expect(await readResetLink(kit.database, token)).toEqual({
    valid: true,
    email: "m@example.com",
  });
  expect(await finish(token)).toEqual({ ok: true, email: "m@example.com" });
  const response = await signIn(kit, "m@example.com", NEW_PASSWORD);
  expect(response.status).toBe(200);
  expect(await response.json()).not.toHaveProperty("twoFactorRedirect");
});

test("the link works once, even when used at the same moment", async () => {
  const token = await issueResetLink(kit.database, member);
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => finish(token, `${NEW_PASSWORD} ${i}`)),
  );
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect((await finish(token)).ok).toBe(false);
  expect(await readResetLink(kit.database, token)).toEqual({ valid: false });
  expect(
    kit.rows(`SELECT id FROM account WHERE user_id = '${member}'`),
  ).toHaveLength(1);
});

test("the link expires", async () => {
  const token = await issueResetLink(kit.database, member);
  const later = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
  expect(await readResetLink(kit.database, token, later)).toEqual({
    valid: false,
  });
  const result = await completeReset(
    kit.auth,
    kit.database,
    { token, password: NEW_PASSWORD },
    later,
  );
  expect(result.ok).toBe(false);
});

test("a new reset cancels the earlier link", async () => {
  const first = await issueResetLink(kit.database, member);
  const second = await issueResetLink(kit.database, member);
  expect(await readResetLink(kit.database, first)).toEqual({ valid: false });
  expect((await readResetLink(kit.database, second)).valid).toBe(true);
});

test("a short password leaves the link usable", async () => {
  const token = await issueResetLink(kit.database, member);
  expect((await finish(token, "short")).ok).toBe(false);
  expect((await finish(token)).ok).toBe(true);
});

test("the link's token is not what the database stores", async () => {
  const token = await issueResetLink(kit.database, member);
  const stored = JSON.stringify(kit.rows("SELECT * FROM verification"));
  expect(stored).not.toContain(token);
});

test("a wrong, used, or expired link is refused without hashing a password", async () => {
  const token = await issueResetLink(kit.database, member);
  const later = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
  expect(
    await countHashes(kit, async () => {
      expect((await finish("not a real token")).ok).toBe(false);
      expect(
        (
          await completeReset(
            kit.auth,
            kit.database,
            { token, password: NEW_PASSWORD },
            later,
          )
        ).ok,
      ).toBe(false);
    }),
  ).toBe(0);
  expect(await countHashes(kit, () => finish(token))).toBe(1);
  expect(await countHashes(kit, () => finish(token))).toBe(0);
});
