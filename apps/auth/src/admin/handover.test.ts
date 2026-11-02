import { beforeEach, expect, test } from "bun:test";
import type { DriveId, UserId } from "../../../../src/db/schema";
import {
  appointNextManagers,
  claimDrive,
  handOverFiles,
  listDrivesToClaim,
  readFilesToHand,
} from "./handover";
import { createKit, type Kit, PASSWORD } from "./test-kit";

let kit: Kit;
let ben: UserId;
let ada: UserId;
let cam: UserId;

const MY_FILES = "11111111-1111-4111-8111-111111111111" as DriveId;
const ALONE = "22222222-2222-4222-8222-222222222222" as DriveId;
const MANAGED = "33333333-3333-4333-8333-333333333333" as DriveId;
const SHARED_OUT = "44444444-4444-4444-8444-444444444444" as DriveId;

async function person(email: string, name: string) {
  const { user } = await kit.auth.api.createUser({
    body: { email, password: PASSWORD, name },
  });
  return user.id as UserId;
}

const access = (driveId: DriveId) =>
  kit.rows(
    `SELECT user_id, role FROM drive_access WHERE drive_id = '${driveId}' ORDER BY user_id`,
  ) as { user_id: string; role: string }[];

const drive = (id: DriveId) =>
  (
    kit.rows(`SELECT kind, name, owner_id FROM drives WHERE id = '${id}'`) as {
      kind: string;
      name: string;
      owner_id: string | null;
    }[]
  )[0];

beforeEach(async () => {
  kit = await createKit();
  ben = await person("ben@example.com", "Ben Okafor");
  ada = await person("ada@example.com", "Ada Stone");
  cam = await person("cam@example.com", "Cam Reyes");
  const insert = (
    id: string,
    kind: string,
    name: string,
    owner: string | null,
  ) =>
    kit.sqlite.run(
      "INSERT INTO drives (id, kind, name, colour, owner_id) VALUES (?, ?, ?, 1, ?)",
      [id, kind, name, owner],
    );
  insert(MY_FILES, "personal", "My files", ben);
  insert(ALONE, "team", "Ben's projects", null);
  insert(MANAGED, "team", "Finance", null);
  insert(SHARED_OUT, "team", "Marketing", null);
  const add = (driveId: string, userId: string, role: string, at: number) =>
    kit.sqlite.run(
      "INSERT INTO drive_access (drive_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      [driveId, userId, role, at],
    );
  add(MY_FILES, ben, "manager", 1);
  add(ALONE, ben, "manager", 1);
  add(MANAGED, ben, "manager", 1);
  add(MANAGED, cam, "viewer", 2);
  add(MANAGED, ada, "editor", 3);
  add(SHARED_OUT, ada, "manager", 1);
  add(SHARED_OUT, ben, "editor", 2);
});

test("the dialog learns what would have nobody", async () => {
  const files = await readFilesToHand(kit.database);
  expect(files.get(ben)).toEqual({
    myFiles: true,
    aloneIn: 1,
    managedAlone: 1,
  });
  expect(files.get(cam)).toBeUndefined();
});

test("My files arrives as a team folder named after the person, and managed by the recipient", async () => {
  await handOverFiles(kit.database, ben, "Ben Okafor", cam);
  expect(drive(MY_FILES)).toEqual({
    kind: "team",
    name: "Ben Okafor's files",
    owner_id: null,
  });
  expect(access(MY_FILES)).toEqual([{ user_id: cam, role: "manager" }]);
});

test("a team folder only they were on goes to the same person", async () => {
  await handOverFiles(kit.database, ben, "Ben Okafor", cam);
  await kit.auth.api.removeUser({
    headers: await adminHeaders(),
    body: { userId: ben },
  });
  expect(access(ALONE)).toEqual([{ user_id: cam, role: "manager" }]);
  expect(drive(ALONE)?.name).toBe("Ben's projects");
});

test("a team folder they managed alone stays with its people, and Can edit counts first", async () => {
  await handOverFiles(kit.database, ben, "Ben Okafor", cam);
  await kit.auth.api.removeUser({
    headers: await adminHeaders(),
    body: { userId: ben },
  });
  const rows = access(MANAGED);
  expect(rows).toContainEqual({ user_id: ada, role: "manager" });
  expect(rows).toContainEqual({ user_id: cam, role: "viewer" });
  expect(rows).toHaveLength(2);
  // Someone else's folder they were only on is untouched.
  expect(access(SHARED_OUT)).toEqual([{ user_id: ada, role: "manager" }]);
});

test("a team folder with another manager gets no new manager", async () => {
  kit.sqlite.run(
    "UPDATE drive_access SET role = 'manager' WHERE drive_id = ? AND user_id = ?",
    [MANAGED, cam],
  );
  await handOverFiles(kit.database, ben, "Ben Okafor", kit.admin);
  expect(access(MANAGED)).toContainEqual({ user_id: ada, role: "editor" });
});

test("with nothing to hand over, their team folders still get a manager", async () => {
  await appointNextManagers(kit.database, ben);
  expect(access(MANAGED)).toContainEqual({ user_id: ada, role: "manager" });
  // Not My files, and not the folder only they were on.
  expect(drive(MY_FILES)?.kind).toBe("personal");
  expect(access(ALONE)).toEqual([{ user_id: ben, role: "manager" }]);
});

test("repeating after the account couldn't be removed changes nothing", async () => {
  await handOverFiles(kit.database, ben, "Ben Okafor", cam);
  const first = JSON.stringify([
    drive(MY_FILES),
    access(MY_FILES),
    access(ALONE),
    access(MANAGED),
    access(SHARED_OUT),
  ]);
  // Removing the account failed here, so the admin chooses Remove again.
  await handOverFiles(kit.database, ben, "Ben Okafor", cam);
  expect(
    JSON.stringify([
      drive(MY_FILES),
      access(MY_FILES),
      access(ALONE),
      access(MANAGED),
      access(SHARED_OUT),
    ]),
  ).toBe(first);
  // Even if they choose someone else the second time, the files stay where they went.
  await handOverFiles(kit.database, ben, "Ben Okafor", kit.admin);
  expect(access(MY_FILES)).toEqual([{ user_id: cam, role: "manager" }]);
  expect(access(ALONE).map((row) => row.user_id)).not.toContain(kit.admin);
});

test("a failure part way leaves nothing changed, and the repeat finishes it", async () => {
  // The last statement in the batch promotes someone. Refuse that, as D1 failing would.
  kit.sqlite.run(
    `CREATE TRIGGER refuse_promotion BEFORE UPDATE OF role ON drive_access
     BEGIN SELECT raise(ABORT, 'database unavailable'); END`,
  );
  await expect(
    handOverFiles(kit.database, ben, "Ben Okafor", cam),
  ).rejects.toThrow("database unavailable");
  expect(drive(MY_FILES)).toEqual({
    kind: "personal",
    name: "My files",
    owner_id: ben,
  });
  expect(access(MY_FILES)).toEqual([{ user_id: ben, role: "manager" }]);
  expect(access(ALONE)).toEqual([{ user_id: ben, role: "manager" }]);

  kit.sqlite.run("DROP TRIGGER refuse_promotion");
  await handOverFiles(kit.database, ben, "Ben Okafor", cam);
  expect(drive(MY_FILES)?.kind).toBe("team");
  expect(access(ALONE)).toContainEqual({ user_id: cam, role: "manager" });
});

// Storage limits arrive in their own change. Once the column exists this test runs for
// real: the database refuses a team folder with a limit, so handing over must clear it in
// the same statement.
test("handing over clears a limit on My files", async () => {
  const limited = () =>
    kit.sqlite.run("UPDATE drives SET limit_bytes = 1000 WHERE id = ?", [
      MY_FILES,
    ]);
  limited();
  await handOverFiles(kit.database, ben, "Ben Okafor", cam);
  expect(
    kit.rows(`SELECT kind, limit_bytes FROM drives WHERE id = '${MY_FILES}'`),
  ).toEqual([{ kind: "team", limit_bytes: null }]);

  // The same for My files left by someone removed before handing over existed.
  kit.sqlite.run(
    "UPDATE drives SET kind = 'personal', owner_id = NULL WHERE id = ?",
    [MY_FILES],
  );
  kit.sqlite.run("DELETE FROM drive_access WHERE drive_id = ?", [MY_FILES]);
  limited();
  await claimDrive(kit.database, MY_FILES, cam);
  expect(
    kit.rows(`SELECT kind, limit_bytes FROM drives WHERE id = '${MY_FILES}'`),
  ).toEqual([{ kind: "team", limit_bytes: null }]);
});

test("a person removed before this existed leaves drives an admin can hand over", async () => {
  await kit.auth.api.removeUser({
    headers: await adminHeaders(),
    body: { userId: ben },
  });
  expect(drive(MY_FILES)?.owner_id).toBeNull();
  const waiting = await listDrivesToClaim(kit.database);
  expect(waiting.map((row) => row.id).sort()).toEqual(
    [ALONE, MANAGED, MY_FILES].sort(),
  );

  await claimDrive(kit.database, MY_FILES, cam);
  expect(drive(MY_FILES)).toEqual({
    kind: "team",
    name: "Files from someone who was removed",
    owner_id: null,
  });
  expect(access(MY_FILES)).toEqual([{ user_id: cam, role: "manager" }]);

  await claimDrive(kit.database, ALONE, cam);
  expect(drive(ALONE)?.name).toBe("Ben's projects");
  expect(access(ALONE)).toEqual([{ user_id: cam, role: "manager" }]);

  // Someone on it, with nobody managing, becomes the manager if they're the one chosen.
  await claimDrive(kit.database, MANAGED, cam);
  expect(access(MANAGED)).toContainEqual({ user_id: cam, role: "manager" });

  expect(await listDrivesToClaim(kit.database)).toEqual([]);
});

test("a second admin handing the same drive to someone else changes nothing", async () => {
  await kit.auth.api.removeUser({
    headers: await adminHeaders(),
    body: { userId: ben },
  });
  await claimDrive(kit.database, MY_FILES, cam);
  await claimDrive(kit.database, MY_FILES, ada);
  expect(access(MY_FILES)).toEqual([{ user_id: cam, role: "manager" }]);
  expect(drive(MY_FILES)?.kind).toBe("team");
});

async function adminHeaders() {
  const { headers } = await kit.auth.api.signInEmail({
    returnHeaders: true,
    body: { email: "boss@example.com", password: PASSWORD },
  });
  return new Headers({
    cookie: (headers.get("set-cookie") ?? "").split(";")[0] ?? "",
  });
}
