import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { DriveId, UserId } from "@cloudysuite/access";
import type { DriveClient } from "./client";
import { parseItemName } from "./names";
import {
  ALICE,
  BOB,
  CAROL,
  createStorageTest,
  DRIVE_A,
  DRIVE_B,
} from "./test-support";
import type { FileItem, ItemId } from "./types";

type Kit = Awaited<ReturnType<typeof createStorageTest>>;
let kit: Kit;

const HOUR = 60 * 60 * 1000;
const MY_FILES = "4f0b1c7e-2d3a-4e5f-8a9b-0c1d2e3f4a5b" as DriveId;

beforeEach(async () => {
  kit = await createStorageTest();
  kit.directory.run(
    "INSERT INTO drives (id, kind, name, colour, owner_id) VALUES (?, 'personal', 'My files', 1, ?)",
    [MY_FILES, ALICE],
  );
  kit.directory.run(
    "INSERT INTO drive_access (drive_id, user_id, role) VALUES (?, ?, 'manager')",
    [MY_FILES, ALICE],
  );
});

afterEach(() => setSystemTime());

const named = (raw: string) => {
  const parsed = parseItemName(raw);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed;
};

const open = async (driveId: DriveId, userId: UserId = BOB) =>
  kit.open(await kit.grantFor(userId, driveId));

async function folder(drive: DriveClient, name: string, parent?: ItemId) {
  const result = await drive.createFolder(parent ?? null, named(name));
  if (result.status !== "created") throw new Error(result.status);
  return result.item;
}

async function startUpload(
  drive: DriveClient,
  name: string,
  parentId: ItemId | null,
  size = 5,
) {
  const started = await drive.uploads.start({
    parentId,
    name,
    size,
    mimeType: "image/png",
    fingerprint: name,
  });
  if (!started.ok) throw new Error(started.message);
  const sent = await drive.uploads.putPart(started.value.id, 1, {
    declaredBytes: size,
    read: async () => new Uint8Array(size).buffer as ArrayBuffer,
  });
  if (!sent.ok) throw new Error(sent.message);
  return started.value.id;
}

async function upload(
  drive: DriveClient,
  name: string,
  parentId: ItemId | null = null,
  size = 5,
): Promise<FileItem> {
  const done = await drive.uploads.complete(
    await startUpload(drive, name, parentId, size),
  );
  if (!done.ok) throw new Error(done.message);
  return done.value;
}

const indexRows = () =>
  kit.directory.query("SELECT user_id, item_id FROM drive_shares").all() as {
    user_id: string;
    item_id: string;
  }[];

const shareRows = (driveId: DriveId) =>
  kit.instance(driveId).db.exec("SELECT item_id FROM shares").toArray();

const usedIn = (driveId: DriveId) =>
  (
    kit.directory
      .query("SELECT used_bytes FROM drives WHERE id = ?")
      .get(driveId) as { used_bytes: number }
  ).used_bytes;

function confirmNeverArrives() {
  const object = kit.instance(DRIVE_B).object;
  const real = object.confirmMoveIn.bind(object);
  object.confirmMoveIn = () => {
    throw new Error("connection lost");
  };
  return () => {
    object.confirmMoveIn = real;
  };
}

test("rows arriving in a shared folder can't be changed through the share until they unlock", async () => {
  const there = await folder(kit.driveB, "There");
  const other = await folder(kit.driveB, "Other");
  await kit.driveB.sharePeople(there.id, [BOB], "edit");
  await kit.driveB.sharePeople(other.id, [BOB], "edit");
  const bob = await open(DRIVE_B);

  const moving = await folder(kit.drive, "Moving");
  const file = await upload(kit.drive, "Report.png", moving.id);
  const mend = confirmNeverArrives();
  expect((await kit.drive.move(moving.id, kit.driveB, there.id)).status).toBe(
    "moved",
  );

  expect((await bob.rename(file.id, named("New.png"))).status).toBe("busy");
  expect((await bob.rename(moving.id, named("New"))).status).toBe("busy");
  expect((await bob.trash(file.id)).status).toBe("busy");
  expect((await bob.trash(moving.id)).status).toBe("busy");
  expect((await bob.move(file.id, bob, other.id)).status).toBe("busy");
  expect((await bob.sharePeople(file.id, [ALICE], "edit")).status).toBe("busy");
  expect((await bob.setEveryone(moving.id, true)).status).toBe("busy");
  expect((await bob.createFolder(moving.id, named("Inside"))).status).toBe(
    "folderBusy",
  );
  // Something of Bob's can't go into the locked folder either, by move or by upload.
  const his = await upload(bob, "His.png", other.id);
  expect((await bob.move(his.id, bob, moving.id)).status).toBe("folderBusy");
  const late = await startUpload(bob, "Late.png", moving.id);
  const waiting = await bob.uploads.complete(late);
  expect(waiting).toMatchObject({ ok: false, status: 503 });

  // The folder around them stays shared, and everyone has the same answer.
  expect((await kit.driveB.rename(file.id, named("New.png"))).status).toBe(
    "busy",
  );
  expect((await bob.trash(there.id)).status).toBe("busy");

  mend();
  kit.restart(DRIVE_A);
  await kit.fireAlarm();
  expect((await bob.rename(file.id, named("New.png"))).status).toBe("renamed");
  expect((await bob.uploads.complete(late)).ok).toBe(true);
});

test("access to a folder can be taken away at once while something arrives in it", async () => {
  const there = await folder(kit.driveB, "There");
  await kit.driveB.sharePeople(there.id, [BOB], "edit");
  await kit.driveB.setEveryone(there.id, true);
  const bob = await open(DRIVE_B);
  const moving = await folder(kit.drive, "Moving");
  const mend = confirmNeverArrives();
  expect((await kit.drive.move(moving.id, kit.driveB, there.id)).status).toBe(
    "moved",
  );

  expect((await kit.driveB.sharePeople(there.id, [CAROL], "view")).status).toBe(
    "busy",
  );
  expect((await kit.driveB.unshare(there.id, BOB)).status).toBe("done");
  expect((await kit.driveB.setEveryone(there.id, false)).status).toBe("done");
  expect(await kit.driveB.sharesOn(there.id)).toMatchObject({ here: [] });
  expect(await bob.item(there.id)).toBeNull();
  await kit.fireAlarm();
  expect(indexRows()).toEqual([]);
  expect((await kit.driveB.setEveryone(there.id, true)).status).toBe("busy");
  mend();
});

test("a share on something being moved can be taken away at once, and stays gone if the move is given up", async () => {
  const docs = await folder(kit.drive, "Docs");
  const file = await upload(kit.drive, "Report.png", docs.id);
  await kit.drive.sharePeople(docs.id, [BOB], "edit");
  await kit.drive.setEveryone(docs.id, true);
  const object = kit.instance(DRIVE_B).object;
  const real = object.receiveMove.bind(object);
  object.receiveMove = async () => {
    throw new Error("connection lost");
  };
  const bob = await open(DRIVE_A);
  await kit.drive.move(docs.id, kit.driveB, null);

  expect((await kit.drive.sharePeople(docs.id, [BOB], "edit")).status).toBe(
    "busy",
  );
  expect((await kit.drive.unshare(docs.id, BOB)).status).toBe("done");
  expect((await kit.drive.setEveryone(docs.id, false)).status).toBe("done");
  expect(await bob.file(file.id)).toBeNull();

  setSystemTime(new Date(Date.now() + HOUR + 1000));
  await kit.instance(DRIVE_A).object.alarm();
  object.receiveMove = real;
  await kit.instance(DRIVE_A).object.alarm();

  expect(await kit.drive.file(file.id)).not.toBeNull();
  expect(shareRows(DRIVE_A)).toEqual([]);
  expect(indexRows()).toEqual([]);
  expect(await bob.file(file.id)).toBeNull();
});

test("shares end when the rows leave, even if the other drive hasn't unlocked yet", async () => {
  const file = await upload(kit.drive, "Report.png");
  await kit.drive.sharePeople(file.id, [BOB], "edit");
  expect(indexRows()).toHaveLength(1);
  const mend = confirmNeverArrives();
  expect((await kit.drive.move(file.id, kit.driveB, null)).status).toBe(
    "moved",
  );

  expect(indexRows()).toEqual([]);
  expect(shareRows(DRIVE_A)).toEqual([]);
  expect(shareRows(DRIVE_B)).toEqual([]);
  expect(await (await open(DRIVE_A)).file(file.id)).toBeNull();
  expect(await (await open(DRIVE_B)).file(file.id)).toBeNull();
  mend();
});

test("a move the other drive refuses leaves the item and its shares as they were", async () => {
  const file = await upload(kit.drive, "Report.png");
  await upload(kit.driveB, "Report.png");
  await kit.drive.sharePeople(file.id, [BOB], "view");
  expect((await kit.drive.move(file.id, kit.driveB, null)).status).toBe(
    "nameTaken",
  );
  expect(indexRows()).toHaveLength(1);
  expect(await (await open(DRIVE_A)).file(file.id)).not.toBeNull();
});

test("giving up on a move leaves the shares on the item that stayed", async () => {
  const docs = await folder(kit.drive, "Docs");
  const file = await upload(kit.drive, "Report.png", docs.id);
  await kit.drive.sharePeople(docs.id, [BOB], "edit");
  const object = kit.instance(DRIVE_B).object;
  const real = object.receiveMove.bind(object);
  object.receiveMove = async (move) => {
    await real(move);
    throw new Error("connection lost");
  };
  const bob = await open(DRIVE_A);

  await kit.drive.move(docs.id, kit.driveB, null);
  // Reading goes on during the move, and changing waits for it.
  expect(await bob.file(file.id)).not.toBeNull();
  expect((await bob.rename(file.id, named("New.png"))).status).toBe("busy");
  expect(await (await open(DRIVE_B)).file(file.id)).toBeNull();

  setSystemTime(new Date(Date.now() + HOUR + 1000));
  await kit.instance(DRIVE_A).object.alarm();
  object.receiveMove = real;
  await kit.instance(DRIVE_A).object.alarm();

  expect(await kit.driveB.file(file.id)).toBeNull();
  expect(shareRows(DRIVE_B)).toEqual([]);
  expect(shareRows(DRIVE_A)).toEqual([{ item_id: docs.id }]);
  expect(indexRows()).toEqual([{ user_id: BOB, item_id: docs.id }]);
  expect((await bob.rename(file.id, named("New.png"))).status).toBe("renamed");
});

test("Can edit through a share gets no way round someone's limit for My files", async () => {
  const myFiles = await open(MY_FILES, ALICE);
  const inbox = await folder(myFiles, "Inbox");
  await myFiles.sharePeople(inbox.id, [BOB], "edit");
  const bob = await open(MY_FILES);
  kit.directory.run("UPDATE drives SET limit_bytes = 10 WHERE id = ?", [
    MY_FILES,
  ]);

  // An upload counts towards the drive it lands in, not the person sending it.
  await upload(bob, "Mine.png", inbox.id, 6);
  expect(usedIn(MY_FILES)).toBe(6);
  const tooBig = await bob.uploads.start({
    parentId: inbox.id,
    name: "Big.png",
    size: 5,
    mimeType: "image/png",
    fingerprint: "big",
  });
  expect(tooBig).toMatchObject({ ok: false, status: 413 });
  if (tooBig.ok) throw new Error("expected a refusal");
  expect(tooBig.message).not.toContain("your 10");
  expect(tooBig.message).toContain("limit for the My files this is in");

  // So does a move, wherever it comes from and however it was reached.
  kit.directory.run(
    "INSERT INTO drive_access (drive_id, user_id, role) VALUES (?, ?, 'editor')",
    [DRIVE_B, BOB],
  );
  const hisTeam = await open(DRIVE_B);
  const big = await upload(hisTeam, "Big.png", null, 5);
  expect(await hisTeam.move(big.id, bob, inbox.id)).toEqual({
    status: "overLimit",
    bytes: 5,
  });
  expect(usedIn(MY_FILES)).toBe(6);
  expect(await hisTeam.file(big.id)).not.toBeNull();
  expect((await hisTeam.rename(big.id, named("Still.png"))).status).toBe(
    "renamed",
  );

  // Two files finishing together can't both take the last of the space.
  const first = await startUpload(bob, "First.png", inbox.id, 3);
  const second = await startUpload(bob, "Second.png", inbox.id, 3);
  const results = await Promise.all([
    bob.uploads.complete(first),
    bob.uploads.complete(second),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(usedIn(MY_FILES)).toBe(9);

  // A small enough move goes through, and frees the room when it leaves.
  const small = await upload(hisTeam, "Small.png", null, 1);
  expect((await hisTeam.move(small.id, bob, inbox.id)).status).toBe("moved");
  expect(usedIn(MY_FILES)).toBe(10);
  expect((await bob.move(small.id, hisTeam, null)).status).toBe("moved");
  expect(usedIn(MY_FILES)).toBe(9);
});

test("someone whose share ended can't finish an upload, or touch the drive's figure", async () => {
  const myFiles = await open(MY_FILES, ALICE);
  const inbox = await folder(myFiles, "Inbox");
  await myFiles.sharePeople(inbox.id, [BOB], "edit");
  const bob = await open(MY_FILES);
  kit.directory.run("UPDATE drives SET limit_bytes = 4 WHERE id = ?", [
    MY_FILES,
  ]);
  const started = await bob.uploads.start({
    parentId: inbox.id,
    name: "Fits.png",
    size: 4,
    mimeType: "image/png",
    fingerprint: "fits",
  });
  if (!started.ok) throw new Error(started.message);
  await bob.uploads.putPart(started.value.id, 1, {
    declaredBytes: 4,
    read: async () => new Uint8Array(4).buffer as ArrayBuffer,
  });
  await myFiles.unshare(inbox.id, BOB);

  // Over the limit as well, which must not close an upload for the wrong reason.
  kit.directory.run("UPDATE drives SET limit_bytes = 1 WHERE id = ?", [
    MY_FILES,
  ]);
  expect(await bob.uploads.complete(started.value.id)).toMatchObject({
    ok: false,
    status: 403,
  });
  expect(usedIn(MY_FILES)).toBe(0);
  expect(await myFiles.list(inbox.id, null)).toMatchObject({ items: [] });
});
