import { beforeEach, expect, test } from "bun:test";
import type { DriveId, UserId } from "@cloudysuite/access";
import { readUpTo } from "@cloudysuite/transfer";
import { downloadResponse } from "./file-responses";
import { limitRefusal } from "./limits";
import { ALICE, BOB, createStorageTest, DRIVE_A } from "./test-support";
import type { UploadView } from "./types";

type Kit = Awaited<ReturnType<typeof createStorageTest>>;
type Client = Kit["drive"];
let kit: Kit;

const MY_FILES = "4f0b1c7e-2d3a-4e5f-8a9b-0c1d2e3f4a5b" as DriveId;
const OTHER_TEAM = "5a1c2d8f-3e4b-4f60-9bac-1d2e3f4a5b6c" as DriveId;

beforeEach(async () => {
  kit = await createStorageTest();
  kit.directory.run(
    "INSERT INTO drives (id, kind, name, colour, owner_id) VALUES (?, 'personal', 'My files', 1, ?)",
    [MY_FILES, ALICE],
  );
  kit.directory.run(
    "INSERT INTO drives (id, kind, name, colour) VALUES (?, 'team', 'Finance', 3)",
    [OTHER_TEAM],
  );
  for (const drive of [MY_FILES, OTHER_TEAM]) {
    kit.directory.run(
      "INSERT INTO drive_access (drive_id, user_id, role) VALUES (?, ?, 'manager')",
      [drive, ALICE],
    );
  }
});

const open = async (driveId: DriveId, userId: UserId = ALICE) =>
  kit.open(await kit.grantFor(userId, driveId));

const setOrgLimit = (bytes: number | null) =>
  kit.directory.run(
    "INSERT INTO org_settings (id, storage_limit_bytes) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET storage_limit_bytes = excluded.storage_limit_bytes",
    [bytes],
  );

const setPersonLimit = (bytes: number | null) =>
  kit.directory.run("UPDATE drives SET limit_bytes = ? WHERE id = ?", [
    bytes,
    MY_FILES,
  ]);

const usedIn = (driveId: DriveId) =>
  (
    kit.directory
      .query("SELECT used_bytes FROM drives WHERE id = ?")
      .get(driveId) as { used_bytes: number }
  ).used_bytes;

const fileNames = async (drive: Client) =>
  (await drive.list(null, null))?.items.map((item) => item.name);

let nextFile = 0;

const start = (drive: Client, size: number) =>
  drive.uploads.start({
    parentId: null,
    name: `file-${(nextFile += 1)}.bin`,
    size,
    mimeType: "application/octet-stream",
    fingerprint: `print-${nextFile}`,
  });

async function sendAll(drive: Client, view: UploadView) {
  const bytes = new Uint8Array(view.size);
  const sent = await drive.uploads.putPart(view.id, 1, {
    declaredBytes: bytes.byteLength,
    read: (limit) => readUpTo(new Blob([bytes]).stream(), limit),
  });
  if (!sent.ok) throw new Error(sent.message);
}

async function startAndSend(drive: Client, size: number) {
  const started = await start(drive, size);
  if (!started.ok) throw new Error(started.message);
  await sendAll(drive, started.value);
  return started.value;
}

async function store(drive: Client, size: number) {
  const view = await startAndSend(drive, size);
  const finished = await drive.uploads.complete(view.id);
  if (!finished.ok) throw new Error(finished.message);
  return finished.value;
}

test("with no limit set, nothing is refused", async () => {
  const myFiles = await open(MY_FILES);
  await store(myFiles, 1000);
  await store(kit.drive, 1000);
  expect(usedIn(MY_FILES)).toBe(1000);
  expect(usedIn(DRIVE_A)).toBe(1000);
});

test("a file that exactly fits the space left is stored", async () => {
  setOrgLimit(100);
  await store(kit.drive, 60);
  await store(kit.drive, 40);
  expect(usedIn(DRIVE_A)).toBe(100);
});

test("the organisation limit refuses at the start, says how much is left, and later files carry on", async () => {
  setOrgLimit(2000);
  await store(kit.drive, 1500);
  const refused = await start(kit.drive, 1000);
  expect(refused).toEqual({
    ok: false,
    status: 413,
    message:
      "This file is 1 KB, and only 500 bytes is left in your organisation's 2 KB limit. Ask your admin for more space.",
  });
  await store(kit.drive, 400);
  expect(usedIn(DRIVE_A)).toBe(1900);
});

test("the organisation limit counts every drive, including a removed person's", async () => {
  setOrgLimit(1000);
  await store(await open(MY_FILES), 600);
  kit.directory.run("DELETE FROM user WHERE id = ?", [ALICE]);
  kit.directory.run(
    "INSERT INTO drive_access (drive_id, user_id, role) VALUES (?, ?, 'manager')",
    [OTHER_TEAM, BOB],
  );
  const other = await open(OTHER_TEAM, BOB);
  expect((await start(other, 500)).ok).toBe(false);
  await store(other, 400);
});

test("a person's limit refuses in My files only, and doesn't reach team folders", async () => {
  setPersonLimit(1000);
  const myFiles = await open(MY_FILES);
  await store(myFiles, 800);

  const refused = await start(myFiles, 500);
  expect(refused).toMatchObject({
    ok: false,
    message:
      "This file is 500 bytes, and only 200 bytes is left in your 1 KB limit for My files. Ask your admin for more space.",
  });

  await store(kit.drive, 5000);
  expect(usedIn(DRIVE_A)).toBe(5000);
});

test("when a file is over both limits, the refusal names the one with less left", () => {
  const room = {
    driveUsedBytes: 90,
    driveLimitBytes: 100,
    orgUsedBytes: 50,
    orgLimitBytes: 100,
  };
  expect(limitRefusal(room, 200)).toContain("limit for My files");
  expect(limitRefusal({ ...room, orgUsedBytes: 95 }, 200)).toContain(
    "organisation",
  );
  expect(limitRefusal({ ...room, driveUsedBytes: 100 }, 200)).toContain(
    "there's no space left in your 100 bytes limit for My files",
  );
});

test("lowering a limit below what's stored deletes nothing and stops new uploads", async () => {
  const file = await store(kit.drive, 1000);
  const myFiles = await open(MY_FILES);
  const mine = await store(myFiles, 1000);
  setOrgLimit(500);
  setPersonLimit(500);

  expect(await fileNames(kit.drive)).toEqual([file.name]);
  expect(await fileNames(myFiles)).toEqual([mine.name]);
  const download = await downloadResponse(kit.drive, file.id);
  expect((await download.arrayBuffer()).byteLength).toBe(1000);
  expect(usedIn(DRIVE_A)).toBe(1000);

  expect((await start(kit.drive, 1)).ok).toBe(false);
  expect((await start(myFiles, 1)).ok).toBe(false);

  setOrgLimit(null);
  setPersonLimit(null);
  await store(kit.drive, 1);
  await store(myFiles, 1);
});

test("uploads started together in one drive can't all pass: exactly those that fit are stored", async () => {
  setOrgLimit(1000);
  const views = await Promise.all(
    [400, 400, 400, 400].map((size) => startAndSend(kit.drive, size)),
  );
  const outcomes = await Promise.all(
    views.map((view) => kit.drive.uploads.complete(view.id)),
  );
  expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(2);
  expect(usedIn(DRIVE_A)).toBe(800);
  const refused = outcomes.find((outcome) => !outcome.ok);
  expect(refused).toMatchObject({
    status: 413,
    message:
      "This file is 400 bytes, and only 200 bytes is left in your organisation's 1 KB limit. Ask your admin for more space.",
  });
});

test("uploads started together in different drives can't all pass the organisation limit", async () => {
  setOrgLimit(1000);
  const myFiles = await open(MY_FILES);
  const other = await open(OTHER_TEAM);
  const started = await Promise.all(
    [kit.drive, myFiles, other].map(async (drive) => ({
      drive,
      view: await startAndSend(drive, 600),
    })),
  );
  const outcomes = await Promise.all(
    started.map(({ drive, view }) => drive.uploads.complete(view.id)),
  );
  expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
  expect(usedIn(DRIVE_A) + usedIn(MY_FILES) + usedIn(OTHER_TEAM)).toBe(600);
});

test("uploads started together in My files can't pass the person's limit", async () => {
  setPersonLimit(1000);
  const myFiles = await open(MY_FILES);
  const views = await Promise.all(
    [600, 600, 600].map((size) => startAndSend(myFiles, size)),
  );
  const outcomes = await Promise.all(
    views.map((view) => myFiles.uploads.complete(view.id)),
  );
  expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
  expect(usedIn(MY_FILES)).toBe(600);
});

test("an upload that stops fitting is refused at the end, its data is removed, and it can be sent again", async () => {
  const view = await startAndSend(kit.drive, 1000);
  setOrgLimit(500);
  const refused = await kit.drive.uploads.complete(view.id);
  expect(refused).toMatchObject({ ok: false, status: 413 });
  expect(await fileNames(kit.drive)).toEqual([]);

  expect(kit.instance().alarm).not.toBeNull();
  expect(kit.instance().alarm as number).toBeLessThanOrEqual(Date.now());
  await kit.fireAlarm();
  expect(kit.bucket.keys(`drives/${DRIVE_A}/`)).toEqual([]);
  expect(kit.bucket.uploads.size).toBe(0);
  expect(
    kit.instance().sqlite.query("SELECT count(*) AS n FROM uploads").get(),
  ).toEqual({ n: 0 });

  setOrgLimit(2000);
  await store(kit.drive, 1000);
  expect(usedIn(DRIVE_A)).toBe(1000);
});

test("uploads in progress hold no space, so one left unfinished never refuses a file that fits", async () => {
  setOrgLimit(1000);
  await startAndSend(kit.drive, 900);
  await store(kit.drive, 900);
  expect(usedIn(DRIVE_A)).toBe(900);
});

test("a D1 failure while a limit is set stores nothing, and trying again finishes the file", async () => {
  setOrgLimit(1000);
  const view = await startAndSend(kit.drive, 400);
  kit.d1Failures.usageWrites = true;
  await expect(kit.drive.uploads.complete(view.id)).rejects.toThrow();
  expect(await fileNames(kit.drive)).toEqual([]);
  kit.d1Failures.usageWrites = false;
  const finished = await kit.drive.uploads.complete(view.id);
  expect(finished.ok).toBe(true);
  expect(usedIn(DRIVE_A)).toBe(400);
});

test("a crash between claiming space and storing the file doesn't leave the space taken", async () => {
  setOrgLimit(1000);
  const view = await startAndSend(kit.drive, 800);
  const { sqlite } = kit.instance();
  sqlite.run(
    "CREATE TRIGGER crash BEFORE INSERT ON items BEGIN SELECT RAISE(ABORT, 'crash'); END",
  );
  await expect(kit.drive.uploads.complete(view.id)).rejects.toThrow();
  expect(usedIn(DRIVE_A)).toBe(800);

  sqlite.run("DROP TRIGGER crash");
  await kit.fireAlarm();
  expect(usedIn(DRIVE_A)).toBe(0);

  const retried = await kit.drive.uploads.complete(view.id);
  expect(retried.ok).toBe(true);
  expect(usedIn(DRIVE_A)).toBe(800);
});

test("the database won't accept a limit on a team folder", () => {
  expect(() =>
    kit.directory.run("UPDATE drives SET limit_bytes = 5 WHERE id = ?", [
      DRIVE_A,
    ]),
  ).toThrow(/drives_limit_only_when_personal/);
});
