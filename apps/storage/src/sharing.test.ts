import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { DriveClient } from "./client";
import { parseItemName } from "./names";
import { downloadResponse, previewResponse } from "./file-responses";
import {
  ALICE,
  BOB,
  CAROL,
  createStorageTest,
  DRIVE_A,
  DRIVE_B,
} from "./test-support";
import { type FileItem, type FolderItem, type ItemId, TRASH_MS } from "./types";

type Kit = Awaited<ReturnType<typeof createStorageTest>>;
let kit: Kit;
let bob: DriveClient;

const named = (raw: string) => {
  const parsed = parseItemName(raw);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed;
};

async function folder(
  name: string,
  parentId: ItemId | null = null,
  drive: DriveClient = kit.drive,
): Promise<FolderItem> {
  const result = await drive.createFolder(parentId, named(name));
  if (result.status !== "created") throw new Error(result.status);
  return result.item;
}

const BYTES = new Uint8Array([1, 2, 3, 4, 5]);
const partBody = {
  declaredBytes: BYTES.length,
  read: async () => BYTES.buffer as ArrayBuffer,
};

async function upload(
  name: string,
  parentId: ItemId | null = null,
  drive: DriveClient = kit.drive,
): Promise<FileItem> {
  const started = await drive.uploads.start({
    parentId,
    name,
    size: BYTES.length,
    mimeType: "image/png",
    fingerprint: "print",
  });
  if (!started.ok) throw new Error(started.message);
  await drive.uploads.putPart(started.value.id, 1, partBody);
  const done = await drive.uploads.complete(started.value.id);
  if (!done.ok) throw new Error(done.message);
  return done.value;
}

const addToDrive = (role: string, driveId = DRIVE_A, userId = BOB) =>
  kit.directory.run(
    "INSERT OR REPLACE INTO drive_access (drive_id, user_id, role) VALUES (?, ?, ?)",
    [driveId, userId, role],
  );

const indexRows = () =>
  kit.directory
    .query("SELECT user_id, drive_id, item_id FROM drive_shares")
    .all() as { user_id: string; drive_id: string; item_id: string }[];

let parent: FolderItem;
let shared: FolderItem;
let sub: FolderItem;
let sibling: FolderItem;
let inner: FileItem;
let deep: FileItem;
let secret: FileItem;
let atRoot: FileItem;

// Parent / Shared / inner.png, Parent / Shared / Sub / deep.png,
// Parent / Sibling / secret.png, and root.png at the top. Only Shared is shared.
beforeEach(async () => {
  kit = await createStorageTest();
  parent = await folder("Parent");
  shared = await folder("Shared", parent.id);
  sub = await folder("Sub", shared.id);
  sibling = await folder("Sibling", parent.id);
  inner = await upload("inner.png", shared.id);
  deep = await upload("deep.png", sub.id);
  secret = await upload("secret.png", sibling.id);
  atRoot = await upload("root.png");
  bob = kit.open(await kit.grantFor(BOB, DRIVE_A));
});

afterEach(() => setSystemTime());

const shareWithBob = (level: "view" | "edit", id: ItemId = shared.id) =>
  kit.drive.sharePeople(id, [BOB], level);

// Everything a person might do to one id. Each entry says whether it got through.
function reads(drive: DriveClient, id: ItemId) {
  return {
    list: async () => (await drive.list(id, null)) !== null,
    opened: async () => (await drive.opened(id)) !== null,
    item: async () => (await drive.item(id)) !== null,
    file: async () => (await drive.file(id)) !== null,
    shares: async () => (await drive.sharesOn(id)) !== null,
    download: async () => (await drive.download(id)) !== null,
    downloadRoute: async () =>
      (await downloadResponse(drive, id)).status === 200,
    previewRoute: async () => (await previewResponse(drive, id)).status === 200,
  };
}

async function writesThatGotThrough(drive: DriveClient, id: ItemId) {
  const got: string[] = [];
  const note = (name: string, status: string) => {
    if (status !== "noAccess") got.push(`${name}:${status}`);
  };
  note("rename", (await drive.rename(id, named("Changed name"))).status);
  note("createFolder", (await drive.createFolder(id, named("New"))).status);
  note("moveWithin", (await drive.move(id, drive, shared.id)).status);
  note("sharePeople", (await drive.sharePeople(id, [CAROL], "view")).status);
  note("unshare", (await drive.unshare(id, CAROL)).status);
  note("setEveryone", (await drive.setEveryone(id, true)).status);
  note("trash", (await drive.trash(id)).status);
  note("restore", (await drive.restore(id)).status);
  const purge = await drive.deleteForever(id);
  if (!purge) got.push("deleteForever");
  const started = await drive.uploads.start({
    parentId: id,
    name: "x.png",
    size: BYTES.length,
    mimeType: "image/png",
    fingerprint: "print",
  });
  if (started.ok) got.push("uploadStart");
  const part = await drive.uploads.putPart(id, 1, partBody);
  if (part.ok) got.push("uploadPart");
  const done = await drive.uploads.complete(id);
  if (done.ok) got.push("uploadComplete");
  return got;
}

test("a share reaches its own subtree and no sibling, by any path", async () => {
  await shareWithBob("edit");

  for (const id of [shared.id, sub.id]) {
    expect(await bob.list(id, null)).not.toBeNull();
  }
  expect(await bob.file(inner.id)).not.toBeNull();
  expect(await bob.file(deep.id)).not.toBeNull();
  expect((await downloadResponse(bob, inner.id)).status).toBe(200);
  expect((await previewResponse(bob, deep.id)).status).toBe(200);

  const missing = crypto.randomUUID() as ItemId;
  for (const id of [
    sibling.id,
    secret.id,
    parent.id,
    atRoot.id,
    missing,
  ] as ItemId[]) {
    for (const [name, attempt] of Object.entries(reads(bob, id))) {
      expect([name, id, await attempt()]).toEqual([name, id, false]);
    }
    expect(await writesThatGotThrough(bob, id)).toEqual([]);
  }

  expect(await bob.list(null, null)).toBeNull();
  // Nothing about the sibling changed through any of that.
  expect(await kit.drive.file(secret.id)).toMatchObject({ name: "secret.png" });
  expect((await kit.drive.list(sibling.id, null))?.items).toHaveLength(1);
});

test("a move can't reach outside a share in either direction", async () => {
  await shareWithBob("edit");
  expect((await bob.move(inner.id, bob, sibling.id)).status).toBe("noAccess");
  expect((await bob.move(inner.id, bob, null)).status).toBe("noAccess");
  expect((await bob.move(secret.id, bob, shared.id)).status).toBe("noAccess");
  expect((await bob.move(inner.id, bob, sub.id)).status).toBe("moved");
});

test("an upload can't continue or be finished through someone else's id", async () => {
  await shareWithBob("edit");
  const aliceUpload = await kit.drive.uploads.start({
    parentId: sibling.id,
    name: "theirs.png",
    size: BYTES.length,
    mimeType: "image/png",
    fingerprint: "other",
  });
  if (!aliceUpload.ok) throw new Error(aliceUpload.message);
  const refused = [
    await bob.uploads.putPart(aliceUpload.value.id, 1, partBody),
    await bob.uploads.complete(aliceUpload.value.id),
    // A finished file's id is also its upload's. This must not describe the file.
    await bob.uploads.complete(secret.id),
    await bob.uploads.putPart(secret.id, 1, partBody),
  ];
  for (const answer of refused) {
    expect(answer).toMatchObject({ ok: false, status: 403 });
  }
  const mine = await upload("mine.png", shared.id, bob);
  expect(mine.createdBy).toBe(BOB);
});

test("a breadcrumb stops at what the person can reach", async () => {
  await shareWithBob("view");
  const listing = await bob.list(sub.id, null);
  expect(listing?.shared).toBe(true);
  expect(listing?.ancestors.map((folder) => folder.name)).toEqual(["Shared"]);
  expect(listing?.ancestors[0]?.parentId).toBeNull();
  const top = await bob.list(shared.id, null);
  expect(top?.ancestors).toEqual([]);
  expect(top?.folder?.parentId).toBeNull();
  expect(JSON.stringify(listing)).not.toContain("Parent");
  expect(JSON.stringify(listing)).not.toContain(parent.id);
  // Someone on the drive still gets the whole trail.
  const full = await kit.drive.list(sub.id, null);
  expect(full?.ancestors.map((folder) => folder.name)).toEqual([
    "Parent",
    "Shared",
  ]);
  expect(full?.shared).toBe(false);
});

test("Can view through a share can read, and every write path refuses", async () => {
  await shareWithBob("view");
  for (const id of [shared.id, sub.id, inner.id]) {
    expect(await writesThatGotThrough(bob, id)).toEqual([]);
  }
  expect((await bob.list(shared.id, null))?.canEdit).toBe(false);
  expect((await downloadResponse(bob, inner.id)).status).toBe(200);
  expect((await previewResponse(bob, inner.id)).status).toBe(200);
  // Move in and out, across drives as well.
  const bobsOwn = kit.open(await kit.grantFor(BOB, DRIVE_B));
  addToDrive("manager", DRIVE_B);
  const bobOnB = kit.open(await kit.grantFor(BOB, DRIVE_B));
  expect((await bob.move(inner.id, bobOnB, null)).status).toBe("noAccess");
  const theirs = await upload("theirs.png", null, bobOnB);
  expect((await bobOnB.move(theirs.id, bob, shared.id)).status).toBe(
    "noAccess",
  );
  void bobsOwn;
  expect((await kit.drive.list(shared.id, null))?.items).toHaveLength(2);
  expect(await kit.drive.sharesOn(inner.id)).toMatchObject({ here: [] });
});

test("Can view on the whole drive can read, and every write path refuses", async () => {
  addToDrive("viewer");
  const viewer = kit.open(await kit.grantFor(BOB, DRIVE_A));
  expect((await viewer.list(null, null))?.canEdit).toBe(false);
  expect((await viewer.list(parent.id, null))?.ancestors).toEqual([]);
  expect((await downloadResponse(viewer, secret.id)).status).toBe(200);
  for (const id of [parent.id, secret.id]) {
    expect(await writesThatGotThrough(viewer, id)).toEqual([]);
  }
  expect((await viewer.createFolder(null, named("Top"))).status).toBe(
    "noAccess",
  );
  const started = await viewer.uploads.start({
    parentId: null,
    name: "x.png",
    size: BYTES.length,
    mimeType: "image/png",
    fingerprint: "print",
  });
  expect(started).toMatchObject({ ok: false, status: 403 });
  expect(await viewer.emptyTrash()).toEqual({ status: "noAccess" });
  await kit.drive.trash(atRoot.id);
  expect(await viewer.restore(atRoot.id)).toEqual({ status: "noAccess" });
  expect(await viewer.deleteForever(atRoot.id)).toEqual({ status: "noAccess" });
  expect(await viewer.trashEntries(10)).toEqual([]);
});

test("an upload already running stops when Can edit becomes Can view", async () => {
  await shareWithBob("edit");
  const started = await bob.uploads.start({
    parentId: shared.id,
    name: "late.png",
    size: BYTES.length,
    mimeType: "image/png",
    fingerprint: "late",
  });
  if (!started.ok) throw new Error(started.message);
  await shareWithBob("view");
  expect(
    await bob.uploads.putPart(started.value.id, 1, partBody),
  ).toMatchObject({ ok: false, status: 403 });
  expect(await bob.uploads.complete(started.value.id)).toMatchObject({
    ok: false,
    status: 403,
  });
});

test("a stronger share lower down gives edit there and view above it", async () => {
  await shareWithBob("view");
  await shareWithBob("edit", sub.id);
  expect((await bob.list(shared.id, null))?.canEdit).toBe(false);
  expect((await bob.list(shared.id, null))?.editableIds).toEqual([sub.id]);
  expect((await bob.list(sub.id, null))?.canEdit).toBe(true);
  expect((await bob.rename(deep.id, named("Better.png"))).status).toBe(
    "renamed",
  );
  expect((await bob.rename(inner.id, named("No.png"))).status).toBe("noAccess");
  // The breadcrumb reaches the outermost folder the person can see.
  expect(
    (await bob.list(sub.id, null))?.ancestors.map((folder) => folder.name),
  ).toEqual(["Shared"]);
});

test("a share covers what's added later, and moving something out ends it", async () => {
  await shareWithBob("view");
  const later = await upload("later.png", sub.id);
  expect(await bob.file(later.id)).not.toBeNull();

  expect((await kit.drive.move(later.id, kit.drive, sibling.id)).status).toBe(
    "moved",
  );
  expect(await bob.file(later.id)).toBeNull();
  expect((await downloadResponse(bob, later.id)).status).toBe(404);

  expect((await kit.drive.move(secret.id, kit.drive, shared.id)).status).toBe(
    "moved",
  );
  expect(await bob.file(secret.id)).not.toBeNull();
});

test("Trash takes a share's reach away, restore brings it back, and purge ends it", async () => {
  await shareWithBob("edit");
  const direct = await upload("direct.png", sub.id);
  await kit.drive.sharePeople(direct.id, [CAROL], "view");
  const carol = kit.open(await kit.grantFor(CAROL, DRIVE_A));
  expect(await carol.file(direct.id)).not.toBeNull();

  // Deleting a folder above takes what's inside.
  await kit.drive.trash(parent.id);
  for (const id of [shared.id, sub.id, inner.id, deep.id]) {
    for (const attempt of Object.values(reads(bob, id))) {
      expect(await attempt()).toBe(false);
    }
  }
  expect(await carol.file(direct.id)).toBeNull();
  expect(await bob.sharedWith(10)).toEqual([]);
  expect(await carol.sharedWith(10)).toEqual([]);
  expect((await bob.rename(inner.id, named("x"))).status).toBe("noAccess");

  await kit.drive.restore(parent.id);
  expect(await bob.file(inner.id)).not.toBeNull();
  expect(await carol.file(direct.id)).not.toBeNull();
  expect((await bob.sharedWith(10)).map((line) => line.item.id)).toEqual([
    shared.id,
  ]);

  await kit.drive.trash(shared.id);
  await kit.drive.deleteForever(shared.id);
  expect(await bob.sharedWith(10)).toEqual([]);
  expect(await carol.sharedWith(10)).toEqual([]);
  expect(indexRows()).toEqual([]);
  expect(kit.instance().db.exec("SELECT * FROM shares").toArray()).toEqual([]);
});

test("the 30 days in Trash ending removes shares the same way", async () => {
  await shareWithBob("view", atRoot.id);
  expect(indexRows()).toHaveLength(1);
  await kit.drive.trash(atRoot.id);
  setSystemTime(new Date(Date.now() + TRASH_MS + 1000));
  await kit.instance().object.alarm();
  setSystemTime();
  expect(indexRows()).toEqual([]);
  expect(kit.instance().db.exec("SELECT * FROM shares").toArray()).toEqual([]);
});

test("someone with Can edit can undo their own delete, but not anyone else's", async () => {
  await shareWithBob("edit");
  expect((await bob.trash(inner.id)).status).toBe("trashed");
  expect(await bob.file(inner.id)).toBeNull();
  expect(await bob.trashEntries(10)).toEqual([]);
  expect((await bob.restore(inner.id)).status).toBe("restored");
  expect(await bob.file(inner.id)).not.toBeNull();

  await kit.drive.trash(inner.id);
  expect((await bob.restore(inner.id)).status).toBe("noAccess");
  expect(await bob.deleteForever(inner.id)).toEqual({ status: "noAccess" });
  expect(await bob.emptyTrash()).toEqual({ status: "noAccess" });

  // Their own delete, once their access has gone, is gone with it.
  await kit.drive.restore(inner.id);
  await bob.trash(inner.id);
  await kit.drive.unshare(shared.id, BOB);
  expect((await bob.restore(inner.id)).status).toBe("noAccess");
});

test("moving to another drive ends the shares, and the README's rule holds", async () => {
  await shareWithBob("view");
  await kit.drive.sharePeople(deep.id, [CAROL], "edit");
  await kit.drive.setEveryone(sub.id, true);
  expect(indexRows()).toHaveLength(2);
  const carol = kit.open(await kit.grantFor(CAROL, DRIVE_A));

  expect((await kit.drive.move(shared.id, kit.driveB, null)).status).toBe(
    "moved",
  );
  const carolOnB = kit.open(await kit.grantFor(CAROL, DRIVE_B));
  const bobOnB = kit.open(await kit.grantFor(BOB, DRIVE_B));
  expect(await bobOnB.list(shared.id, null)).toBeNull();
  expect(await carolOnB.file(deep.id)).toBeNull();
  expect(await bobOnB.list(sub.id, null)).toBeNull();
  expect(await carol.file(deep.id)).toBeNull();
  expect(indexRows()).toEqual([]);
  expect(
    kit.instance(DRIVE_B).db.exec("SELECT * FROM shares").toArray(),
  ).toEqual([]);

  // Coming into a shared folder on the other drive picks up that folder's sharing.
  const there = await folder("There", null, kit.driveB);
  await kit.driveB.sharePeople(there.id, [BOB], "view");
  await kit.driveB.move(sub.id, kit.driveB, there.id);
  expect(await bobOnB.file(deep.id)).not.toBeNull();
});

test("everyone in the organisation can view through a link, and never edit", async () => {
  await kit.drive.setEveryone(shared.id, true);
  expect(await bob.file(inner.id)).not.toBeNull();
  expect((await bob.list(shared.id, null))?.canEdit).toBe(false);
  expect(await bob.file(secret.id)).toBeNull();
  expect((await bob.rename(inner.id, named("x"))).status).toBe("noAccess");
  // It isn't sent to anyone, so it doesn't show on their page.
  expect(await bob.sharedWith(10)).toEqual([]);
  expect(indexRows()).toEqual([]);
  // Saying it twice changes nothing, and the table can't hold an edit level on it.
  await kit.drive.setEveryone(shared.id, true);
  const db = kit.instance().db;
  expect(() =>
    db.exec(
      "INSERT INTO shares (item_id, kind, user_id, level, shared_by, shared_at) VALUES ('x', 'organisation', NULL, 'edit', 'a', 1)",
    ),
  ).toThrow();
  expect(() =>
    db.exec(
      "INSERT INTO shares (item_id, kind, user_id, level, shared_by, shared_at) VALUES ('x', 'person', NULL, 'view', 'a', 1)",
    ),
  ).toThrow();

  await kit.drive.setEveryone(shared.id, false);
  expect(await bob.file(inner.id)).toBeNull();
});

test("Shared with me lists direct shares with who and when, and the current name", async () => {
  await shareWithBob("view");
  await kit.drive.sharePeople(atRoot.id, [BOB], "edit");
  const lines = await bob.sharedWith(10);
  expect(lines.map((line) => line.item.id).sort()).toEqual(
    [shared.id, atRoot.id].sort(),
  );
  expect(lines[0]?.sharedBy).toBe(ALICE);
  expect(lines.find((line) => line.item.id === atRoot.id)?.canEdit).toBe(true);
  // Not what's inside a shared folder.
  expect(lines.map((line) => line.item.id)).not.toContain(inner.id);
  // A parent stays out of it.
  expect(lines.every((line) => line.item.parentId === null)).toBe(true);
  await kit.drive.rename(shared.id, named("Renamed"));
  expect((await bob.sharedWith(10)).map((line) => line.item.name)).toContain(
    "Renamed",
  );
});

test("a share with Can edit can share onward, but can't reach further", async () => {
  await shareWithBob("edit");
  expect((await bob.sharePeople(sub.id, [CAROL], "view")).status).toBe("done");
  expect((await bob.setEveryone(sub.id, true)).status).toBe("done");
  expect((await bob.sharePeople(sibling.id, [CAROL], "view")).status).toBe(
    "noAccess",
  );
  expect(await bob.sharesOn(sibling.id)).toBeNull();
  const carol = kit.open(await kit.grantFor(CAROL, DRIVE_A));
  expect(await carol.file(deep.id)).not.toBeNull();
  expect(await carol.file(inner.id)).toBeNull();
});

test("being taken off a drive or banned counts from the next request", async () => {
  addToDrive("editor");
  const asMember = await kit.grantFor(BOB, DRIVE_A);
  expect(await kit.open(asMember).file(secret.id)).not.toBeNull();
  kit.directory.run("DELETE FROM drive_access WHERE user_id = ?", [BOB]);
  expect(
    await kit.open(await kit.grantFor(BOB, DRIVE_A)).file(secret.id),
  ).toBeNull();

  await shareWithBob("view");
  expect(
    await kit.open(await kit.grantFor(BOB, DRIVE_A)).file(inner.id),
  ).not.toBeNull();
  kit.directory.run("UPDATE user SET banned = 1 WHERE id = ?", [BOB]);
  await expect(kit.grantFor(BOB, DRIVE_A)).rejects.toThrow("expected access");
});

test("a share taken away stops that person straight away", async () => {
  await shareWithBob("view");
  expect(await bob.file(inner.id)).not.toBeNull();
  await kit.drive.unshare(shared.id, BOB);
  expect(await bob.file(inner.id)).toBeNull();
  expect(indexRows()).toEqual([]);
});

test("the index failing changes nobody's access, and the alarm catches it up", async () => {
  kit.d1Failures.shareIndex = true;
  await shareWithBob("view");
  // The share is already true. The page's list is what's late.
  expect(await bob.file(inner.id)).not.toBeNull();
  expect(indexRows()).toEqual([]);
  expect(kit.instance().alarm).not.toBeNull();

  await kit.fireAlarm();
  expect(indexRows()).toEqual([]);

  kit.d1Failures.shareIndex = false;
  await kit.fireAlarm();
  expect(indexRows()).toEqual([
    { user_id: BOB, drive_id: DRIVE_A, item_id: shared.id },
  ]);
  await kit.fireAlarm();
  expect(indexRows()).toHaveLength(1);
});

test("a stale index row shows nothing and opens nothing", async () => {
  await shareWithBob("view");
  kit.d1Failures.shareIndex = true;
  await kit.drive.unshare(shared.id, BOB);
  expect(indexRows()).toHaveLength(1);
  expect(await bob.sharedWith(10)).toEqual([]);
  expect(await bob.file(inner.id)).toBeNull();
  kit.d1Failures.shareIndex = false;
  await kit.fireAlarm();
  expect(indexRows()).toEqual([]);
});

test("the index can't be written for someone removed, and that isn't a failure", async () => {
  kit.d1Failures.shareIndex = true;
  await shareWithBob("view");
  kit.d1Failures.shareIndex = false;
  kit.directory.run("DELETE FROM user WHERE id = ?", [BOB]);
  await kit.fireAlarm();
  expect(indexRows()).toEqual([]);
  expect(
    kit.instance().db.exec("SELECT * FROM share_index_writes").toArray(),
  ).toEqual([]);
});

test("the Worker's answer doesn't depend on whether an id exists", async () => {
  await shareWithBob("view");
  const missing = crypto.randomUUID() as ItemId;
  const answers = await Promise.all(
    [secret.id, missing].map(async (id) => ({
      opened: await bob.opened(id),
      rename: await bob.rename(id, named("x")),
      trash: await bob.trash(id),
      share: await bob.sharePeople(id, [CAROL], "view"),
      complete: await bob.uploads.complete(id),
    })),
  );
  expect(answers[0]).toEqual(answers[1] as NonNullable<(typeof answers)[1]>);
});

test("a team folder can only close when it's empty, including Trash and uploads", async () => {
  const empty = kit.driveB;
  const held = await upload("held.png", null, empty);
  expect((await empty.close()).status).toBe("notEmpty");
  await empty.trash(held.id);
  expect((await empty.close()).status).toBe("notEmpty");
  await empty.deleteForever(held.id);

  const started = await empty.uploads.start({
    parentId: null,
    name: "going.png",
    size: BYTES.length,
    mimeType: "image/png",
    fingerprint: "going",
  });
  if (!started.ok) throw new Error(started.message);
  expect((await empty.close()).status).toBe("notEmpty");
  await kit
    .instance(DRIVE_B)
    .db.exec("DELETE FROM uploads WHERE id = ?", started.value.id);

  expect((await empty.close()).status).toBe("closed");
  expect((await empty.close()).status).toBe("closed");
  // Nothing can land after it's found empty.
  expect((await empty.createFolder(null, named("Late"))).status).toBe(
    "noAccess",
  );
  expect((await kit.drive.move(atRoot.id, empty, null)).status).toBe(
    "noAccess",
  );
  await empty.reopen();
  expect((await empty.createFolder(null, named("Back"))).status).toBe(
    "created",
  );
});
