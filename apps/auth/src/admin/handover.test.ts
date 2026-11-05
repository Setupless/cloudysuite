import { beforeEach, expect, test } from "bun:test";
import type { CalendarId, DriveId, UserId } from "../../../../src/db/schema";
import {
  appointNextManagers,
  claimDrive,
  handOver,
  listDrivesToClaim,
  readToHand,
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

const THEIR_CALENDAR = "55555555-5555-4555-8555-555555555555" as CalendarId;
const CALENDAR_ALONE = "66666666-6666-4666-8666-666666666666" as CalendarId;
const WITH_AN_EDITOR = "77777777-7777-4777-8777-777777777777" as CalendarId;
const ALL_VIEWERS = "88888888-8888-4888-8888-888888888888" as CalendarId;

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

const calendarAccess = (calendarId: CalendarId) =>
  kit.rows(
    `SELECT user_id, role FROM calendar_access WHERE calendar_id = '${calendarId}' ORDER BY user_id`,
  ) as { user_id: string; role: string }[];

const rolesOn = (calendarId: CalendarId) =>
  Object.fromEntries(
    calendarAccess(calendarId).map(({ user_id, role }) => [user_id, role]),
  );

const calendar = (id: CalendarId) =>
  (
    kit.rows(
      `SELECT kind, name, owner_id, colour FROM calendars WHERE id = '${id}'`,
    ) as {
      kind: string;
      name: string | null;
      owner_id: string | null;
      colour: number;
    }[]
  )[0];

const everything = () =>
  JSON.stringify([
    drive(MY_FILES),
    ...[MY_FILES, ALONE, MANAGED, SHARED_OUT].map(access),
    calendar(THEIR_CALENDAR),
    ...[THEIR_CALENDAR, CALENDAR_ALONE, WITH_AN_EDITOR, ALL_VIEWERS].map(
      calendarAccess,
    ),
  ]);

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
  add(MANAGED, cam, "viewer", 3);
  add(MANAGED, ada, "editor", 2);
  add(SHARED_OUT, ada, "manager", 1);
  add(SHARED_OUT, ben, "editor", 2);

  kit.sqlite.run(
    "INSERT INTO calendars (id, kind, colour, owner_id) VALUES (?, 'personal', 4, ?)",
    [THEIR_CALENDAR, ben],
  );
  for (const [id, name] of [
    [CALENDAR_ALONE, "Ben's planning"],
    [WITH_AN_EDITOR, "Launch"],
    [ALL_VIEWERS, "Rota"],
  ] as const) {
    kit.sqlite.run(
      "INSERT INTO calendars (id, kind, name, colour) VALUES (?, 'team', ?, 1)",
      [id, name],
    );
  }
  const join = (id: string, userId: string, role: string, at: number) =>
    kit.sqlite.run(
      "INSERT INTO calendar_access (calendar_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      [id, userId, role, at],
    );
  join(THEIR_CALENDAR, ben, "manager", 1);
  join(CALENDAR_ALONE, ben, "manager", 1);
  join(WITH_AN_EDITOR, ben, "manager", 1);
  join(WITH_AN_EDITOR, cam, "viewer", 2);
  join(WITH_AN_EDITOR, ada, "editor", 3);
  join(ALL_VIEWERS, ben, "manager", 1);
  join(ALL_VIEWERS, cam, "viewer", 2);
  join(ALL_VIEWERS, ada, "viewer", 3);
});

async function remove(personId: UserId) {
  await kit.auth.api.removeUser({
    headers: await adminHeaders(),
    body: { userId: personId },
  });
}

test("the dialog learns what would have nobody", async () => {
  const toHand = await readToHand(kit.database);
  expect(toHand.get(ben)).toEqual({
    files: { personal: true, aloneIn: 1, managedAlone: 1 },
    calendars: { personal: true, aloneIn: 1, managedAlone: 2 },
  });
  expect(toHand.get(cam)).toBeUndefined();
});

test("My files arrives as a team folder named after the person, and managed by the recipient", async () => {
  await handOver(kit.database, ben, "Ben Okafor", cam);
  expect(drive(MY_FILES)).toEqual({
    kind: "team",
    name: "Ben Okafor's files",
    owner_id: null,
  });
  expect(access(MY_FILES)).toEqual([{ user_id: cam, role: "manager" }]);
});

test("a team folder only they were on goes to the same person", async () => {
  await handOver(kit.database, ben, "Ben Okafor", cam);
  await kit.auth.api.removeUser({
    headers: await adminHeaders(),
    body: { userId: ben },
  });
  expect(access(ALONE)).toEqual([{ user_id: cam, role: "manager" }]);
  expect(drive(ALONE)?.name).toBe("Ben's projects");
});

test("a team folder they managed alone stays with its people, and Can edit counts first", async () => {
  await handOver(kit.database, ben, "Ben Okafor", cam);
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
  await handOver(kit.database, ben, "Ben Okafor", kit.admin);
  expect(access(MANAGED)).toContainEqual({ user_id: ada, role: "editor" });
});

test("with nothing to hand over, their team folders and calendars still get a manager", async () => {
  await appointNextManagers(kit.database, ben);
  expect(access(MANAGED)).toContainEqual({ user_id: ada, role: "manager" });
  expect(calendarAccess(WITH_AN_EDITOR)).toContainEqual({
    user_id: ada,
    role: "manager",
  });
  // Not My files, and not the folder only they were on.
  expect(drive(MY_FILES)?.kind).toBe("personal");
  expect(access(ALONE)).toEqual([{ user_id: ben, role: "manager" }]);
});

test("repeating after the account couldn't be removed changes nothing", async () => {
  await handOver(kit.database, ben, "Ben Okafor", cam);
  const first = everything();
  // Removing the account failed here, so the admin chooses Remove again.
  await handOver(kit.database, ben, "Ben Okafor", cam);
  expect(everything()).toBe(first);
  // Even if they choose someone else the second time, everything stays where it went.
  await handOver(kit.database, ben, "Ben Okafor", kit.admin);
  expect(everything()).toBe(first);

  await remove(ben);
  const removed = everything();
  await handOver(kit.database, ben, "Ben Okafor", cam);
  expect(everything()).toBe(removed);
});

test("a failure part way leaves nothing changed, and the repeat finishes it", async () => {
  // The last statement in the batch promotes someone. Refuse that, as D1 failing would.
  kit.sqlite.run(
    `CREATE TRIGGER refuse_promotion BEFORE UPDATE OF role ON drive_access
     BEGIN SELECT raise(ABORT, 'database unavailable'); END`,
  );
  await expect(handOver(kit.database, ben, "Ben Okafor", cam)).rejects.toThrow(
    "database unavailable",
  );
  expect(drive(MY_FILES)).toEqual({
    kind: "personal",
    name: "My files",
    owner_id: ben,
  });
  expect(access(MY_FILES)).toEqual([{ user_id: ben, role: "manager" }]);
  expect(access(ALONE)).toEqual([{ user_id: ben, role: "manager" }]);
  expect(calendar(THEIR_CALENDAR)?.kind).toBe("personal");
  expect(calendarAccess(CALENDAR_ALONE)).toEqual([
    { user_id: ben, role: "manager" },
  ]);

  kit.sqlite.run("DROP TRIGGER refuse_promotion");
  await handOver(kit.database, ben, "Ben Okafor", cam);
  expect(drive(MY_FILES)?.kind).toBe("team");
  expect(access(ALONE)).toContainEqual({ user_id: cam, role: "manager" });
  expect(calendar(THEIR_CALENDAR)?.kind).toBe("team");
});

test("their calendar arrives as a team calendar named after them, and managed by the recipient", async () => {
  await handOver(kit.database, ben, "Ben Okafor", cam);
  await remove(ben);
  const handed = calendar(THEIR_CALENDAR);
  expect(handed).toMatchObject({
    kind: "team",
    name: "Ben Okafor's calendar",
    owner_id: null,
  });
  // A team calendar never takes a personal calendar's colour.
  expect([1, 2, 3, 5, 6]).toContain(handed?.colour ?? 0);
  expect(calendarAccess(THEIR_CALENDAR)).toEqual([
    { user_id: cam, role: "manager" },
  ]);
});

test("each team calendar they managed alone gets a manager, the way a team folder does", async () => {
  await handOver(kit.database, ben, "Ben Okafor", cam);
  await remove(ben);
  // Nobody else was on it, so it goes to the person chosen.
  expect(calendarAccess(CALENDAR_ALONE)).toEqual([
    { user_id: cam, role: "manager" },
  ]);
  expect(calendar(CALENDAR_ALONE)?.name).toBe("Ben's planning");
  // Can edit counts first, even for someone who joined later.
  expect(rolesOn(WITH_AN_EDITOR)).toEqual({
    [ada]: "manager",
    [cam]: "viewer",
  });
  // With only Can view left, whoever has been on it longest.
  expect(rolesOn(ALL_VIEWERS)).toEqual({ [ada]: "viewer", [cam]: "manager" });
  expect(
    kit.rows(`SELECT 1 FROM calendar_access WHERE user_id = '${ben}'`),
  ).toEqual([]);
});

test("their own calendar's name fits the longest name a calendar can have", async () => {
  await handOver(kit.database, ben, "B".repeat(300), cam);
  expect(calendar(THEIR_CALENDAR)?.name).toHaveLength(100);
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
  await handOver(kit.database, ben, "Ben Okafor", cam);
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
