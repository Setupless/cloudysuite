import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { DriveClient } from "./client";
import { downloadResponse, previewResponse } from "./file-responses";
import { parseItemName } from "./names";
import { createStorageTest, DRIVE_A, DRIVE_B } from "./test-support";
import {
  type FileItem,
  type ItemId,
  MAX_ITEMS_ACROSS_DRIVES,
  TRASH_MS,
} from "./types";

type Kit = Awaited<ReturnType<typeof createStorageTest>>;
let kit: Kit;

beforeEach(async () => {
  kit = await createStorageTest();
});

afterEach(() => setSystemTime());

const named = (raw: string) => {
  const parsed = parseItemName(raw);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed;
};

async function folder(
  name: string,
  parentId: ItemId | null = null,
  drive: DriveClient = kit.drive,
) {
  const result = await drive.createFolder(parentId, named(name));
  if (result.status !== "created") throw new Error(result.status);
  return result.item;
}

async function upload(
  name: string,
  parentId: ItemId | null = null,
  bytes = new Uint8Array([1, 2, 3, 4, 5]),
  drive: DriveClient = kit.drive,
): Promise<FileItem> {
  const started = await drive.uploads.start({
    parentId,
    name,
    size: bytes.length,
    mimeType: "image/png",
    fingerprint: "print",
  });
  if (!started.ok) throw new Error(started.message);
  const sent = await drive.uploads.putPart(started.value.id, 1, {
    declaredBytes: bytes.length,
    read: async () => bytes.buffer as ArrayBuffer,
  });
  if (!sent.ok) throw new Error(sent.message);
  const done = await drive.uploads.complete(started.value.id);
  if (!done.ok) throw new Error(done.message);
  return done.value;
}

const names = async (
  parentId: ItemId | null = null,
  drive: DriveClient = kit.drive,
) => (await drive.list(parentId, null))?.items.map((item) => item.name);

const trashNames = async (drive: DriveClient = kit.drive) =>
  (await drive.trashEntries(200)).map((entry) => entry.name);

const usage = (drive = DRIVE_A) => {
  const row = kit.driveRow(drive);
  return { bytes: row.used_bytes, files: row.file_count };
};

// Runs the alarm until nothing is left to do now.
async function settle(drive = DRIVE_A) {
  for (let turn = 0; turn < 50; turn += 1) {
    const at = kit.instance(drive).alarm;
    if (at === null || at > Date.now()) return;
    await kit.instance(drive).object.alarm();
  }
  throw new Error("the alarm never settled");
}

test("rename follows the same rules as a new name and refuses a taken one", async () => {
  await upload("Taken.pdf");
  const file = await upload("Report.pdf");
  expect(await kit.drive.rename(file.id, named("taken.PDF"))).toEqual({
    status: "nameTaken",
  });
  const renamed = await kit.drive.rename(file.id, named("Summary.pdf"));
  expect(renamed.status).toBe("renamed");
  expect(await names()).toEqual(["Summary.pdf", "Taken.pdf"]);
});

test("a name can change only its own case", async () => {
  const file = await upload("report.pdf");
  expect((await kit.drive.rename(file.id, named("Report.pdf"))).status).toBe(
    "renamed",
  );
  expect(await names()).toEqual(["Report.pdf"]);
});

test("a folder can't move into itself or anything inside it", async () => {
  const top = await folder("Top");
  const middle = await folder("Middle", top.id);
  const bottom = await folder("Bottom", middle.id);
  for (const target of [top.id, middle.id, bottom.id]) {
    expect(await kit.drive.move(top.id, kit.drive, target)).toEqual({
      status: "intoItself",
    });
  }
  expect(await names()).toEqual(["Top"]);
});

test("moving within a drive refuses a taken name and otherwise keeps the totals", async () => {
  const target = await folder("Target");
  await upload("Report.pdf", target.id);
  const file = await upload("Report.pdf");
  expect(await kit.drive.move(file.id, kit.drive, target.id)).toEqual({
    status: "nameTaken",
  });
  const other = await upload("Other.pdf");
  expect(await kit.drive.move(other.id, kit.drive, target.id)).toEqual({
    status: "moved",
  });
  expect(await names(target.id)).toEqual(["Other.pdf", "Report.pdf"]);
  expect(usage()).toEqual({ bytes: 15, files: 3 });
});

test("delete frees the name, and the item leaves listings, counts and Recent", async () => {
  const docs = await folder("Docs");
  const file = await upload("Report.pdf", docs.id);
  await kit.drive.trash(file.id);
  expect(await names(docs.id)).toEqual([]);
  expect((await kit.drive.list(null, null))?.items[0]).toMatchObject({
    name: "Docs",
    contains: 0,
  });
  expect((await kit.drive.list(docs.id, null))?.contains).toBe(0);
  expect(await kit.drive.recent(10)).toEqual([]);
  expect(await trashNames()).toEqual(["Report.pdf"]);
  expect((await upload("Report.pdf", docs.id)).name).toBe("Report.pdf");
});

test("a trashed file gives a plain 404 for both download and preview", async () => {
  const file = await upload("Photo.png");
  expect((await downloadResponse(kit.drive, file.id)).status).toBe(200);
  await kit.drive.trash(file.id);
  expect((await downloadResponse(kit.drive, file.id)).status).toBe(404);
  expect((await previewResponse(kit.drive, file.id)).status).toBe(404);
  expect(await kit.drive.file(file.id)).toBeNull();
});

test("deleting a folder takes its contents, shows one line, and restores as one unit", async () => {
  const docs = await folder("Docs");
  const inner = await folder("Inner", docs.id);
  const deep = await upload("Deep.pdf", inner.id);
  await upload("Top.pdf", docs.id);
  expect(usage()).toEqual({ bytes: 10, files: 2 });

  await kit.drive.trash(docs.id);
  expect(await names()).toEqual([]);
  expect(usage()).toEqual({ bytes: 10, files: 0 });
  expect(await kit.drive.list(inner.id, null)).toBeNull();
  expect((await downloadResponse(kit.drive, deep.id)).status).toBe(404);
  expect(await kit.drive.trashEntries(10)).toMatchObject([
    { name: "Docs", kind: "folder", size: 10, contains: 3 },
  ]);

  expect(await kit.drive.restore(docs.id)).toMatchObject({
    status: "restored",
    folderGone: false,
  });
  expect(await names(docs.id)).toEqual(["Inner", "Top.pdf"]);
  expect(await names(inner.id)).toEqual(["Deep.pdf"]);
  expect(await trashNames()).toEqual([]);
  expect(usage()).toEqual({ bytes: 10, files: 2 });
  expect((await downloadResponse(kit.drive, deep.id)).status).toBe(200);
});

test("restoring into a taken name keeps both", async () => {
  const first = await upload("Report.pdf");
  await kit.drive.trash(first.id);
  const second = await upload("Report.pdf");
  const restored = await kit.drive.restore(first.id);
  expect(restored).toMatchObject({
    status: "restored",
    item: { id: first.id, name: "Report (2).pdf" },
  });
  expect(await names()).toEqual(["Report (2).pdf", "Report.pdf"]);
  expect(second.name).toBe("Report.pdf");
});

test("an item whose folder is gone returns to the drive's root and says so", async () => {
  const docs = await folder("Docs");
  const file = await upload("Report.pdf", docs.id);
  await kit.drive.trash(file.id);
  // Trash sorts newest first, and two deletions in one millisecond have no order.
  setSystemTime(new Date(Date.now() + 1000));
  await kit.drive.trash(docs.id);
  expect(await kit.drive.trashEntries(10)).toMatchObject([
    { name: "Docs" },
    { name: "Report.pdf", fromFolder: { name: null } },
  ]);
  expect(await kit.drive.restore(file.id)).toMatchObject({
    status: "restored",
    folderGone: true,
    item: { parentId: null },
  });
  expect(await names()).toEqual(["Report.pdf"]);
});

test("a file deleted from a folder doesn't block deleting that folder forever", async () => {
  const docs = await folder("Docs");
  const file = await upload("Report.pdf", docs.id);
  await kit.drive.trash(file.id);
  await kit.drive.trash(docs.id);
  await kit.drive.deleteForever(docs.id);
  expect(await trashNames()).toEqual(["Report.pdf"]);
  expect(await kit.drive.restore(file.id)).toMatchObject({
    folderGone: true,
  });
});

test("bytes count until deleted forever, and then the object goes from R2", async () => {
  const file = await upload("Report.pdf");
  await upload("Stays.pdf");
  await kit.drive.trash(file.id);
  expect(usage()).toEqual({ bytes: 10, files: 1 });
  expect(kit.bucket.objects.size).toBe(2);

  await kit.drive.deleteForever(file.id);
  expect(await trashNames()).toEqual([]);
  expect(usage()).toEqual({ bytes: 5, files: 1 });
  expect((await kit.drive.restore(file.id)).status).toBe("gone");

  await settle();
  expect(kit.bucket.objects.size).toBe(1);
  expect(kit.instance().alarm).toBeNull();
});

test("Trash empties itself after 30 days", async () => {
  const start = Date.now();
  const docs = await folder("Docs");
  await upload("Inside.pdf", docs.id);
  await kit.drive.trash(docs.id);
  await upload("Stays.pdf");

  await settle();
  expect(await trashNames()).toEqual(["Docs"]);
  expect(kit.instance().alarm).toBe(
    (await kit.drive.trashEntries(1))[0]?.purgeAt ?? null,
  );

  setSystemTime(new Date(start + TRASH_MS - 60_000));
  expect(await trashNames()).toEqual(["Docs"]);

  setSystemTime(new Date(start + TRASH_MS + 60_000));
  expect(await trashNames()).toEqual([]);
  expect((await kit.drive.restore(docs.id)).status).toBe("gone");
  await settle();
  expect(usage()).toEqual({ bytes: 5, files: 1 });
  expect(kit.bucket.objects.size).toBe(1);
  expect(await names()).toEqual(["Stays.pdf"]);
});

test("a large unit purges in small batches, and each batch can be repeated", async () => {
  const docs = await folder("Docs");
  const count = 230;
  for (let n = 0; n < count; n += 1) {
    await upload(`File ${n}.txt`, docs.id, new Uint8Array([n % 256]));
  }
  await kit.drive.trash(docs.id);
  const sqlite = kit.instance().sqlite;
  sqlite.run("UPDATE items SET purge_at = 0 WHERE id = ?", [docs.id]);
  await kit.instance().object.alarm();
  const left = () =>
    (sqlite.query("SELECT count(*) AS n FROM items").get() as { n: number }).n;
  expect(left()).toBe(count + 1 - 100);
  expect(usage().bytes).toBe(count - 100);

  await settle();
  expect(left()).toBe(0);
  expect(usage()).toEqual({ bytes: 0, files: 0 });
  expect(kit.bucket.objects.size).toBe(0);

  await kit.instance().object.alarm();
  expect(usage()).toEqual({ bytes: 0, files: 0 });
});

test("R2 failing leaves the deletion queued and it finishes later", async () => {
  const file = await upload("Report.pdf");
  await kit.drive.trash(file.id);
  kit.bucket.failDeletes = true;
  await kit.drive.deleteForever(file.id);
  await kit.instance().object.alarm();
  expect(kit.bucket.objects.size).toBe(1);
  expect(kit.instance().alarm).toBeGreaterThan(Date.now());

  kit.bucket.failDeletes = false;
  await kit.fireAlarm();
  expect(kit.bucket.objects.size).toBe(0);
  expect(kit.instance().alarm).toBeNull();
});

test("Empty Trash removes only what's in Trash", async () => {
  const gone = await upload("Gone.pdf");
  await upload("Stays.pdf");
  await kit.drive.trash(gone.id);
  await kit.drive.emptyTrash();
  await settle();
  expect(await trashNames()).toEqual([]);
  expect(await names()).toEqual(["Stays.pdf"]);
  expect(usage()).toEqual({ bytes: 5, files: 1 });
  expect(kit.bucket.objects.size).toBe(1);
});

test("an upload whose folder went to Trash lands at the root, and new ones are refused", async () => {
  const docs = await folder("Docs");
  const started = await kit.drive.uploads.start({
    parentId: docs.id,
    name: "Late.pdf",
    size: 1,
    mimeType: "application/pdf",
    fingerprint: "late",
  });
  if (!started.ok) throw new Error(started.message);
  await kit.drive.uploads.putPart(started.value.id, 1, {
    declaredBytes: 1,
    read: async () => new Uint8Array([9]).buffer,
  });
  await kit.drive.trash(docs.id);
  const done = await kit.drive.uploads.complete(started.value.id);
  expect(done).toMatchObject({ ok: true, value: { parentId: null } });
  expect(await names()).toEqual(["Late.pdf"]);
  expect(
    (
      await kit.drive.uploads.start({
        parentId: docs.id,
        name: "New.pdf",
        size: 1,
        mimeType: "application/pdf",
        fingerprint: "new",
      })
    ).ok,
  ).toBe(false);
  expect((await kit.drive.createFolder(docs.id, named("Sub"))).status).toBe(
    "noParent",
  );
});

test("an upload into a folder deleted forever stops, and doesn't hold the folder back", async () => {
  const docs = await folder("Docs");
  const started = await kit.drive.uploads.start({
    parentId: docs.id,
    name: "Late.pdf",
    size: 1,
    mimeType: "application/pdf",
    fingerprint: "late",
  });
  if (!started.ok) throw new Error(started.message);
  await kit.drive.trash(docs.id);
  await kit.drive.deleteForever(docs.id);
  expect(await trashNames()).toEqual([]);
  expect(
    (
      await kit.drive.uploads.putPart(started.value.id, 1, {
        declaredBytes: 1,
        read: async () => new Uint8Array([9]).buffer,
      })
    ).ok,
  ).toBe(false);
});

test("a folder moves to another drive with its contents, bytes and totals", async () => {
  const docs = await folder("Docs");
  const inner = await folder("Inner", docs.id);
  const file = await upload("Deep.pdf", inner.id);
  await upload("Stays.pdf");
  const target = await folder("Target", null, kit.driveB);

  expect(await kit.drive.move(docs.id, kit.driveB, target.id)).toEqual({
    status: "moved",
  });
  expect(await names()).toEqual(["Stays.pdf"]);
  expect(await names(target.id, kit.driveB)).toEqual(["Docs"]);
  expect(await names(inner.id, kit.driveB)).toEqual(["Deep.pdf"]);
  expect(usage(DRIVE_A)).toEqual({ bytes: 5, files: 1 });
  expect(usage(DRIVE_B)).toEqual({ bytes: 5, files: 1 });

  expect((await downloadResponse(kit.driveB, file.id)).status).toBe(200);
  expect((await downloadResponse(kit.drive, file.id)).status).toBe(404);
  expect(kit.bucket.objects.size).toBe(2);

  await kit.driveB.trash(file.id);
  await kit.driveB.deleteForever(file.id);
  await settle(DRIVE_B);
  expect(kit.bucket.objects.size).toBe(1);
  expect(usage(DRIVE_B)).toEqual({ bytes: 0, files: 0 });
});

test("a move across drives that loses its answer finishes from the alarm, once", async () => {
  const file = await upload("Report.pdf");
  const receiver = kit.instance(DRIVE_B).object;
  const real = receiver.receiveMove.bind(receiver);
  // The receiver commits and the answer never comes back, as in a crash.
  receiver.receiveMove = async (...args) => {
    await real(...args);
    throw new Error("connection lost");
  };
  expect(await kit.drive.move(file.id, kit.driveB, null)).toEqual({
    status: "pending",
  });
  expect(await names()).toEqual(["Report.pdf"]);
  expect((await kit.drive.rename(file.id, named("New.pdf"))).status).toBe(
    "busy",
  );
  expect((await kit.drive.trash(file.id)).status).toBe("busy");
  expect(await names(null, kit.driveB)).toEqual(["Report.pdf"]);

  receiver.receiveMove = real;
  await kit.fireAlarm();
  expect(await names()).toEqual([]);
  expect(await names(null, kit.driveB)).toEqual(["Report.pdf"]);
  expect(usage(DRIVE_A)).toEqual({ bytes: 0, files: 0 });
  expect(usage(DRIVE_B)).toEqual({ bytes: 5, files: 1 });
  expect(kit.bucket.objects.size).toBe(1);
  expect(kit.instance().alarm).toBeNull();
});

test("a move across drives refused by a taken name leaves everything where it was", async () => {
  const file = await upload("Report.pdf");
  await upload("Report.pdf", null, undefined, kit.driveB);
  expect(await kit.drive.move(file.id, kit.driveB, null)).toEqual({
    status: "nameTaken",
  });
  expect(await names()).toEqual(["Report.pdf"]);
  expect((await kit.drive.rename(file.id, named("Mine.pdf"))).status).toBe(
    "renamed",
  );
  expect(usage(DRIVE_A)).toEqual({ bytes: 5, files: 1 });
  expect(usage(DRIVE_B)).toEqual({ bytes: 5, files: 1 });
});

test("a folder too big to cross in one call is refused in place", async () => {
  const docs = await folder("Docs");
  const sqlite = kit.instance().sqlite;
  for (let n = 0; n <= MAX_ITEMS_ACROSS_DRIVES; n += 1) {
    sqlite.run(
      `INSERT INTO items (id, parent_id, kind, name, name_key, created_by, created_at, changed_at)
       VALUES (?, ?, 'folder', ?, ?, 'x', 0, 0)`,
      [crypto.randomUUID(), docs.id, `n${n}`, `n${n}`],
    );
  }
  expect(await kit.drive.move(docs.id, kit.driveB, null)).toEqual({
    status: "tooMany",
  });
  expect(await names()).toEqual(["Docs"]);
});
