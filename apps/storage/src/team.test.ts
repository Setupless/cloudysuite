import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkDriveAccess } from "@cloudysuite/access";
import {
  addToTeam,
  deleteTeam,
  readTeam,
  removeFromTeam,
  renameTeam,
  setTeamRole,
} from "./team";
import { ALICE, BOB, CAROL, createStorageTest, DRIVE_A } from "./test-support";

let kit: Awaited<ReturnType<typeof createStorageTest>>;

beforeEach(async () => {
  kit = await createStorageTest();
});

const roles = async () =>
  Object.fromEntries(
    (await readTeam(kit.d1, DRIVE_A)).map(({ person, role }) => [
      person.id,
      role,
    ]),
  );

test("a manager adds people, and adding someone again keeps their role", async () => {
  await addToTeam(kit.d1, DRIVE_A, [BOB, CAROL], "editor");
  expect(await roles()).toEqual({
    [ALICE]: "manager",
    [BOB]: "editor",
    [CAROL]: "editor",
  });
  await setTeamRole(kit.d1, DRIVE_A, BOB, "viewer");
  await addToTeam(kit.d1, DRIVE_A, [BOB], "editor");
  expect((await roles())[BOB]).toBe("viewer");
  await addToTeam(kit.d1, DRIVE_A, [ALICE], "viewer");
  expect((await roles())[ALICE]).toBe("manager");
});

test("the last manager can't step down, be demoted, or leave", async () => {
  await addToTeam(kit.d1, DRIVE_A, [BOB], "editor");
  expect(await setTeamRole(kit.d1, DRIVE_A, ALICE, "viewer")).toBe(
    "lastManager",
  );
  expect(await removeFromTeam(kit.d1, DRIVE_A, ALICE)).toBe("lastManager");
  expect((await roles())[ALICE]).toBe("manager");

  expect(await setTeamRole(kit.d1, DRIVE_A, BOB, "manager")).toBe("done");
  expect(await removeFromTeam(kit.d1, DRIVE_A, ALICE)).toBe("done");
  expect(await roles()).toEqual({ [BOB]: "manager" });
  expect(await removeFromTeam(kit.d1, DRIVE_A, BOB)).toBe("lastManager");
});

test("two managers stepping down together leave one", async () => {
  await addToTeam(kit.d1, DRIVE_A, [BOB], "manager");
  const answers = await Promise.all([
    removeFromTeam(kit.d1, DRIVE_A, ALICE),
    setTeamRole(kit.d1, DRIVE_A, BOB, "viewer"),
  ]);
  expect(answers.sort()).toEqual(["done", "lastManager"]);
  expect(Object.values(await roles())).toContain("manager");
});

test("anyone on it can leave, and it says when they aren't", async () => {
  await addToTeam(kit.d1, DRIVE_A, [BOB], "viewer");
  expect(await removeFromTeam(kit.d1, DRIVE_A, BOB)).toBe("done");
  expect(await removeFromTeam(kit.d1, DRIVE_A, BOB)).toBe("notOnIt");
  expect(await setTeamRole(kit.d1, DRIVE_A, BOB, "editor")).toBe("notOnIt");
  const after = await checkDriveAccess(kit.d1, BOB, DRIVE_A);
  expect(after).toMatchObject({ allowed: true, grant: { role: null } });
});

test("My files takes no members and can't be renamed or deleted as a team folder", async () => {
  const mine = "aa3f4e30-ac2d-4f90-9e77-2c3d4e5f6071" as typeof DRIVE_A;
  kit.directory.run(
    "INSERT INTO drives (id, kind, name, colour, owner_id) VALUES (?, 'personal', 'My files', 1, ?)",
    [mine, ALICE],
  );
  await addToTeam(kit.d1, mine, [BOB], "editor");
  expect(await readTeam(kit.d1, mine)).toEqual([]);
  await renameTeam(kit.d1, mine, "Mine now");
  await deleteTeam(kit.d1, mine);
  expect(
    kit.directory.query("SELECT name FROM drives WHERE id = ?").get(mine),
  ).toEqual({ name: "My files" });
});

test("the migration keeps every row, and member becomes Can edit", () => {
  const dir = join(import.meta.dir, "../../../migrations");
  const all = readdirSync(dir).sort();
  const last = all.at(-1) as string;
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const name of all.slice(0, -1)) {
    sqlite.run(readFileSync(join(dir, name, "migration.sql"), "utf8"));
  }
  sqlite.run(
    "INSERT INTO user (id, name, email) VALUES ('u1', 'A', 'a@x'), ('u2', 'B', 'b@x')",
  );
  sqlite.run(
    "INSERT INTO drives (id, kind, name, colour, owner_id) VALUES ('d1', 'team', 'T', 1, NULL), ('d2', 'personal', 'My files', 1, 'u1')",
  );
  sqlite.run(
    "INSERT INTO drive_access (drive_id, user_id, role) VALUES ('d1', 'u1', 'manager'), ('d1', 'u2', 'member'), ('d2', 'u1', 'manager')",
  );
  const source = readFileSync(join(dir, last, "migration.sql"), "utf8");
  expect(source).not.toMatch(/DROP TABLE|__new_/i);
  sqlite.run(source);
  expect(
    sqlite
      .query(
        "SELECT drive_id, user_id, role FROM drive_access ORDER BY drive_id, user_id",
      )
      .all(),
  ).toEqual([
    { drive_id: "d1", user_id: "u1", role: "manager" },
    { drive_id: "d1", user_id: "u2", role: "editor" },
    { drive_id: "d2", user_id: "u1", role: "manager" },
  ]);
  expect(sqlite.query("SELECT count(*) AS n FROM drives").get()).toEqual({
    n: 2,
  });
});
