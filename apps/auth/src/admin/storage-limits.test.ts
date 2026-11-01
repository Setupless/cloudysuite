import { beforeEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UserId } from "../../../../src/db/schema";
import { testWorkerEnv } from "../../../../src/db/test-database";
import { readLimitBytes } from "./input";
import {
  readStorageOverview,
  setMyFilesLimit,
  setStorageLimit,
} from "./organisation";
import { listPeople } from "./people";
import {
  bytesToLimitText,
  MAX_LIMIT_BYTES,
  parseLimitText,
} from "./storage-limit-text";
import { createKit, type Kit, PASSWORD, signIn } from "./test-kit";

let kit: Kit;
let member: UserId;

const workers = {
  env: testWorkerEnv as unknown as Record<string, unknown>,
  DurableObject: class {},
};
mock.module("cloudflare:workers", () => workers);
const { requireAdminUser } = await import("../guard");

beforeEach(async () => {
  kit = await createKit();
  workers.env.DB = kit.database;
  workers.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-0123";
  const { user } = await kit.auth.api.createUser({
    body: {
      email: "member@example.com",
      password: PASSWORD,
      name: "Member",
      role: "user",
    },
  });
  member = user.id as UserId;
});

const driveOf = (userId: UserId) =>
  kit.rows(
    `SELECT limit_bytes, kind FROM drives WHERE owner_id = '${userId}'`,
  ) as { limit_bytes: number | null; kind: string }[];

async function requestAs(email: string) {
  const response = await signIn(kit, email);
  return new Request("https://auth.example.com/_serverFn/x", {
    method: "POST",
    headers: { cookie: response.headers.get("set-cookie") ?? "" },
  });
}

test("a member is refused by the admin guard, and an admin passes", async () => {
  const refused = await requireAdminUser(
    await requestAs("member@example.com"),
  ).catch((thrown: unknown) => thrown);
  expect(refused).toBeInstanceOf(Response);
  expect((refused as Response).status).toBe(403);
  expect(await (refused as Response).json()).toEqual({
    message: "Only an admin can do this.",
  });

  const admin = await requireAdminUser(await requestAs("boss@example.com"));
  expect(admin.id).toBe(kit.admin);
});

test("both functions that change a limit go through the admin guard", () => {
  const source = readFileSync(join(import.meta.dir, "functions.ts"), "utf8");
  for (const name of ["changeStorageLimit", "changeMyFilesLimit"]) {
    expect(source).toMatch(
      new RegExp(
        `export const ${name} = createServerFn\\(\\{ method: "POST" \\}\\)\\s+\\.middleware\\(\\[adminOnly\\]\\)`,
      ),
    );
  }
});

test("the organisation limit can be set, changed, and cleared, keeping other settings", async () => {
  kit.sqlite.run("INSERT INTO org_settings (id, require_2fa) VALUES (1, 1)");
  expect(await readStorageOverview(kit.database)).toEqual({
    usedBytes: 0,
    limitBytes: null,
  });
  await setStorageLimit(kit.database, 5000);
  expect((await readStorageOverview(kit.database)).limitBytes).toBe(5000);
  await setStorageLimit(kit.database, null);
  expect((await readStorageOverview(kit.database)).limitBytes).toBeNull();
  expect(kit.rows("SELECT require_2fa FROM org_settings")).toEqual([
    { require_2fa: 1 },
  ]);
});

test("a person with no My files can be given a limit, and it makes exactly one", async () => {
  await setMyFilesLimit(kit.database, member, 1000);
  await setMyFilesLimit(kit.database, member, 2000);
  expect(driveOf(member)).toEqual([{ limit_bytes: 2000, kind: "personal" }]);
  expect(
    kit.rows(`SELECT role FROM drive_access WHERE user_id = '${member}'`),
  ).toEqual([{ role: "manager" }]);

  const { people } = await listPeople(kit.database);
  expect(people.find((person) => person.id === member)?.myFiles).toEqual({
    usedBytes: 0,
    limitBytes: 2000,
  });
  expect(people.find((person) => person.id === kit.admin)?.myFiles).toBeNull();
});

test("clearing a limit keeps the drive, and makes none for a person who has none", async () => {
  await setMyFilesLimit(kit.database, member, 1000);
  await setMyFilesLimit(kit.database, member, null);
  expect(driveOf(member)).toEqual([{ limit_bytes: null, kind: "personal" }]);

  await setMyFilesLimit(kit.database, kit.admin, null);
  expect(driveOf(kit.admin)).toEqual([]);
});

test("the limit field reads GB and says what to fix", () => {
  expect(parseLimitText(" 100 ")).toEqual({ ok: true, bytes: 100e9 });
  expect(parseLimitText("0.5")).toEqual({ ok: true, bytes: 5e8 });
  for (const bad of ["", "0", "-1", "ten", "1,000", "1e3", "1000001"]) {
    expect(parseLimitText(bad).ok).toBe(false);
  }
  expect(bytesToLimitText(100e9)).toBe("100");
  expect(bytesToLimitText(null)).toBe("");
});

test("the server takes a whole number of bytes in range, or null", () => {
  expect(readLimitBytes({ limitBytes: null })).toBeNull();
  expect(readLimitBytes({ limitBytes: 5 })).toBe(5);
  for (const bad of [
    {},
    { limitBytes: 0 },
    { limitBytes: -1 },
    { limitBytes: 1.5 },
    { limitBytes: "5" },
    { limitBytes: MAX_LIMIT_BYTES + 1 },
  ]) {
    expect(() => readLimitBytes(bad)).toThrow();
  }
});
