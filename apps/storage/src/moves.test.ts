import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { DriveId } from "@cloudysuite/access";
import type { DriveClient } from "./client";
import { downloadResponse } from "./file-responses";
import { moveRefusal, readStorageRoom } from "./limits";
import { parseItemName } from "./names";
import { ALICE, createStorageTest, DRIVE_A, DRIVE_B } from "./test-support";
import type { FileItem, ItemId } from "./types";

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

async function startUpload(
  name: string,
  parentId: ItemId | null,
  size: number,
  drive: DriveClient,
) {
  const bytes = new Uint8Array(size);
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
    read: async () => bytes.buffer as ArrayBuffer,
  });
  if (!sent.ok) throw new Error(sent.message);
  return started.value.id;
}

async function upload(
  name: string,
  parentId: ItemId | null = null,
  size = 5,
  drive: DriveClient = kit.drive,
): Promise<FileItem> {
  const id = await startUpload(name, parentId, size, drive);
  const done = await drive.uploads.complete(id);
  if (!done.ok) throw new Error(done.message);
  return done.value;
}

const names = async (
  drive: DriveClient = kit.drive,
  parentId: ItemId | null = null,
) => (await drive.list(parentId, null))?.items.map((item) => item.name);

const trashNames = async (drive: DriveClient = kit.drive) =>
  (await drive.trashEntries(200)).map((entry) => entry.name);

const usage = (drive: DriveId = DRIVE_A) => {
  const row = kit.driveRow(drive);
  return { bytes: row.used_bytes, files: row.file_count };
};

const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));

const HOUR = 60 * 60 * 1000;

// Each makes one step between the two drives fail once it has or hasn't committed, and
// gives back the way to mend it.
function receiverCommitsThenLosesAnswer() {
  const object = kit.instance(DRIVE_B).object;
  const real = object.receiveMove.bind(object);
  object.receiveMove = async (move) => {
    await real(move);
    throw new Error("connection lost");
  };
  return () => {
    object.receiveMove = real;
  };
}

function receiverNeverAnswers() {
  const object = kit.instance(DRIVE_B).object;
  const real = object.receiveMove.bind(object);
  object.receiveMove = async () => {
    throw new Error("connection lost");
  };
  return () => {
    object.receiveMove = real;
  };
}

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

function confirmCommitsThenLosesAnswer() {
  const object = kit.instance(DRIVE_B).object;
  const real = object.confirmMoveIn.bind(object);
  object.confirmMoveIn = (moveId) => {
    real(moveId);
    throw new Error("connection lost");
  };
  return () => {
    object.confirmMoveIn = real;
  };
}

// Everything a person could do to a row that must not touch its bytes yet.
async function expectLocked(file: FileItem, drive: DriveClient) {
  expect((await drive.rename(file.id, named("Other.pdf"))).status).toBe("busy");
  expect((await drive.trash(file.id)).status).toBe("busy");
  expect((await drive.move(file.id, drive, null)).status).toBe("busy");
  await drive.deleteForever(file.id);
  await drive.emptyTrash();
  expect(await trashNames(drive)).toEqual([]);
}

async function expectBytesSafe(file: FileItem, holder: DriveClient) {
  for (let turn = 0; turn < 3; turn += 1) {
    const object = kit.instance(holder.driveId).object;
    await object.alarm();
  }
  expect(kit.bucket.objects.size).toBe(1);
  expect((await downloadResponse(holder, file.id)).status).toBe(200);
}

test("the blocker: deleting the copy that arrived can't destroy the only bytes", async () => {
  const file = await upload("Report.pdf");
  const mend = receiverCommitsThenLosesAnswer();
  expect((await kit.drive.move(file.id, kit.driveB, null)).status).toBe(
    "pending",
  );
  expect(await names(kit.driveB)).toEqual(["Report.pdf"]);

  await expectLocked(file, kit.driveB);
  await expectLocked(file, kit.drive);
  await expectBytesSafe(file, kit.drive);
  expect(await names()).toEqual(["Report.pdf"]);

  mend();
  await kit.fireAlarm();
  expect(await names()).toEqual([]);
  expect((await downloadResponse(kit.driveB, file.id)).status).toBe(200);
});

test("crash before the delivery commits: the alarm delivers it once", async () => {
  const file = await upload("Report.pdf");
  const mend = receiverNeverAnswers();
  expect((await kit.drive.move(file.id, kit.driveB, null)).status).toBe(
    "pending",
  );
  expect(await names(kit.driveB)).toEqual([]);
  await expectLocked(file, kit.drive);

  mend();
  kit.restart(DRIVE_A);
  await kit.fireAlarm();
  expect(await names()).toEqual([]);
  expect(await names(kit.driveB)).toEqual(["Report.pdf"]);
  expect(usage(DRIVE_A)).toEqual({ bytes: 0, files: 0 });
  expect(usage(DRIVE_B)).toEqual({ bytes: 5, files: 1 });
  expect((await kit.driveB.rename(file.id, named("New.pdf"))).status).toBe(
    "renamed",
  );
});

test("crash after the receiver commits: the repeat adds nothing and the move ends", async () => {
  const file = await upload("Report.pdf");
  const mend = receiverCommitsThenLosesAnswer();
  await kit.drive.move(file.id, kit.driveB, null);
  mend();
  kit.restart(DRIVE_A);
  kit.restart(DRIVE_B);
  await kit.fireAlarm();
  expect(usage(DRIVE_A)).toEqual({ bytes: 0, files: 0 });
  expect(usage(DRIVE_B)).toEqual({ bytes: 5, files: 1 });
  expect(await names()).toEqual([]);
  expect(await names(kit.driveB)).toEqual(["Report.pdf"]);
  expect(kit.instance(DRIVE_A).alarm).toBeNull();
});

test("crash after the sender removes its rows: the copy stays locked until told", async () => {
  const file = await upload("Report.pdf");
  const mend = confirmNeverArrives();
  // The person sees it moved, because the rows have already crossed.
  expect((await kit.drive.move(file.id, kit.driveB, null)).status).toBe(
    "moved",
  );
  expect(await names()).toEqual([]);
  expect(usage(DRIVE_A)).toEqual({ bytes: 0, files: 0 });
  await expectLocked(file, kit.driveB);
  await expectBytesSafe(file, kit.driveB);

  mend();
  kit.restart(DRIVE_A);
  await kit.fireAlarm();
  expect((await kit.driveB.trash(file.id)).status).toBe("trashed");
  expect(kit.instance(DRIVE_A).alarm).toBeNull();
});

test("the unlock's answer lost: asking again changes nothing, and deleting then works", async () => {
  const file = await upload("Report.pdf");
  const mend = confirmCommitsThenLosesAnswer();
  expect((await kit.drive.move(file.id, kit.driveB, null)).status).toBe(
    "moved",
  );
  expect((await kit.driveB.rename(file.id, named("New.pdf"))).status).toBe(
    "renamed",
  );
  mend();
  await kit.fireAlarm();
  expect(kit.instance(DRIVE_A).alarm).toBeNull();
  expect(await names(kit.driveB)).toEqual(["New.pdf"]);

  await kit.driveB.trash(file.id);
  await kit.driveB.deleteForever(file.id);
  await kit.instance(DRIVE_B).object.alarm();
  expect(kit.bucket.objects.size).toBe(0);
  expect(usage(DRIVE_B)).toEqual({ bytes: 0, files: 0 });
});

test("a late copy of a delivery can't add the rows again after the move ended", async () => {
  const file = await upload("Report.pdf");
  const object = kit.instance(DRIVE_B).object;
  const real = object.receiveMove.bind(object);
  let delivered: Parameters<typeof real>[0] | null = null;
  object.receiveMove = async (move) => {
    delivered = move;
    return real(move);
  };
  await kit.drive.move(file.id, kit.driveB, null);
  object.receiveMove = real;
  await kit.driveB.trash(file.id);
  await kit.driveB.deleteForever(file.id);
  if (!delivered) throw new Error("expected a delivery");

  expect(await real(delivered)).toEqual({ status: "received" });
  expect(await names(kit.driveB)).toEqual([]);
  expect(usage(DRIVE_B)).toEqual({ bytes: 0, files: 0 });
});

test("a destination that refuses leaves the source unlocked and usable", async () => {
  const file = await upload("Report.pdf");
  await upload("Report.pdf", null, 5, kit.driveB);
  expect((await kit.drive.move(file.id, kit.driveB, null)).status).toBe(
    "nameTaken",
  );
  expect((await kit.drive.rename(file.id, named("Mine.pdf"))).status).toBe(
    "renamed",
  );
  expect(kit.instance(DRIVE_A).alarm).toBeNull();
  await kit.driveB.rename(
    (await kit.driveB.list(null, null))?.items[0]?.id as ItemId,
    named("Other.pdf"),
  );
  expect((await kit.drive.move(file.id, kit.driveB, null)).status).toBe(
    "moved",
  );
});

test("a destination that never answers: the source frees itself and keeps its bytes", async () => {
  const file = await upload("Report.pdf");
  const object = kit.instance(DRIVE_B).object;
  const real = object.receiveMove.bind(object);
  let delivery: Parameters<typeof real>[0] | null = null;
  object.receiveMove = async (move) => {
    delivery = move;
    throw new Error("connection lost");
  };
  await kit.drive.move(file.id, kit.driveB, null);
  expect((await kit.drive.trash(file.id)).status).toBe("busy");

  later(HOUR + 1000);
  await kit.instance(DRIVE_A).object.alarm();
  expect(await names()).toEqual(["Report.pdf"]);
  expect((await kit.drive.rename(file.id, named("Mine.pdf"))).status).toBe(
    "renamed",
  );
  await kit.instance(DRIVE_A).object.alarm();
  expect(kit.instance(DRIVE_A).alarm).toBeNull();
  expect(usage(DRIVE_A)).toEqual({ bytes: 5, files: 1 });

  // A copy of the delivery still on its way can't arrive after the source moved on.
  object.receiveMove = real;
  if (!delivery) throw new Error("expected a delivery");
  expect(await real(delivery)).toEqual({ status: "noDestination" });
  expect(await names(kit.driveB)).toEqual([]);
  expect(usage(DRIVE_B)).toEqual({ bytes: 0, files: 0 });
  expect((await downloadResponse(kit.drive, file.id)).status).toBe(200);
});

test("giving up after the receiver committed takes its rows back without touching the bytes", async () => {
  const docs = await folder("Docs");
  const file = await upload("Report.pdf", docs.id);
  const mend = receiverCommitsThenLosesAnswer();
  await kit.drive.move(docs.id, kit.driveB, null);
  expect(usage(DRIVE_B)).toEqual({ bytes: 5, files: 1 });
  // Someone starts an upload into the locked copy, which must not hold it back.
  const late = await startUpload("Late.pdf", docs.id, 1, kit.driveB);

  later(HOUR + 1000);
  await kit.instance(DRIVE_A).object.alarm();
  expect(await names(kit.drive, docs.id)).toEqual(["Report.pdf"]);

  mend();
  // A failed tell comes round again, and a repeat of it subtracts nothing twice.
  const object = kit.instance(DRIVE_B).object;
  const realAbandon = object.abandonMoveIn.bind(object);
  object.abandonMoveIn = async (...args) => {
    await realAbandon(...args);
    throw new Error("connection lost");
  };
  await kit.instance(DRIVE_A).object.alarm();
  object.abandonMoveIn = realAbandon;
  await kit.fireAlarm();
  expect(await names(kit.driveB)).toEqual([]);
  expect(usage(DRIVE_B)).toEqual({ bytes: 0, files: 0 });
  expect(usage(DRIVE_A)).toEqual({ bytes: 5, files: 1 });
  expect(kit.instance(DRIVE_A).alarm).toBeNull();
  expect((await kit.driveB.uploads.complete(late)).ok).toBe(false);

  await kit.instance(DRIVE_B).object.alarm();
  expect((await downloadResponse(kit.drive, file.id)).status).toBe(200);
});

test("restoring into a folder being moved refuses for now, and works afterwards", async () => {
  const docs = await folder("Docs");
  const file = await upload("Report.pdf", docs.id);
  await kit.drive.trash(file.id);
  const mend = receiverNeverAnswers();
  await kit.drive.move(docs.id, kit.driveB, null);

  expect(await kit.drive.restore(file.id)).toEqual({ status: "folderBusy" });
  expect(await trashNames()).toEqual(["Report.pdf"]);

  later(HOUR + 1000);
  await kit.instance(DRIVE_A).object.alarm();
  mend();
  await kit.instance(DRIVE_A).object.alarm();
  expect(await kit.drive.restore(file.id)).toMatchObject({
    status: "restored",
    folderGone: false,
    item: { parentId: docs.id },
  });
});

test("restoring after its folder moved away for good returns to the root and says so", async () => {
  const docs = await folder("Docs");
  const file = await upload("Report.pdf", docs.id);
  await kit.drive.trash(file.id);
  await kit.drive.move(docs.id, kit.driveB, null);
  expect(await kit.drive.restore(file.id)).toMatchObject({
    status: "restored",
    folderGone: true,
    item: { parentId: null },
  });
});

test("nothing can be added to a folder being moved, on either side", async () => {
  const docs = await folder("Docs");
  const mend = receiverCommitsThenLosesAnswer();
  const other = await upload("Other.pdf");
  await kit.drive.move(docs.id, kit.driveB, null);

  for (const drive of [kit.drive, kit.driveB]) {
    expect((await drive.createFolder(docs.id, named("Sub"))).status).toBe(
      "folderBusy",
    );
  }
  expect((await kit.drive.move(other.id, kit.drive, docs.id)).status).toBe(
    "folderBusy",
  );
  const coming = await upload("Coming.pdf", null, 1, kit.driveB);
  expect((await kit.driveB.move(coming.id, kit.driveB, docs.id)).status).toBe(
    "folderBusy",
  );
  mend();
  expect((await kit.drive.move(other.id, kit.driveB, docs.id)).status).toBe(
    "folderBusy",
  );
  expect(await names()).toEqual(["Docs", "Other.pdf"]);
});

test("an upload finishing while its folder is being moved waits rather than landing at the root", async () => {
  const docs = await folder("Docs");
  const late = await startUpload("Late.pdf", docs.id, 1, kit.drive);
  const mend = receiverNeverAnswers();
  await kit.drive.move(docs.id, kit.driveB, null);

  const waiting = await kit.drive.uploads.complete(late);
  expect(waiting).toMatchObject({
    ok: false,
    status: 503,
    message: "That folder is being moved. Try again in a minute.",
  });
  expect(await names()).toEqual(["Docs"]);

  later(HOUR + 1000);
  await kit.instance(DRIVE_A).object.alarm();
  mend();
  await kit.instance(DRIVE_A).object.alarm();
  expect(await kit.drive.uploads.complete(late)).toMatchObject({
    ok: true,
    value: { name: "Late.pdf", parentId: docs.id },
  });
});

const STOPPED = /deleted or moved somewhere else/;

test("an upload whose folder moved to another drive says what happened", async () => {
  const docs = await folder("Docs");
  const late = await startUpload("Late.pdf", docs.id, 1, kit.drive);
  await kit.drive.move(docs.id, kit.driveB, null);
  const finished = await kit.drive.uploads.complete(late);
  expect(!finished.ok && finished.message).toMatch(STOPPED);
  const part = await kit.drive.uploads.putPart(late, 1, {
    declaredBytes: 1,
    read: async () => new Uint8Array([1]).buffer,
  });
  expect(!part.ok && part.message).toMatch(STOPPED);
});

test("an upload whose folder was deleted forever says what happened", async () => {
  const docs = await folder("Docs");
  const late = await startUpload("Late.pdf", docs.id, 1, kit.drive);
  await kit.drive.trash(docs.id);
  await kit.drive.deleteForever(docs.id);
  const finished = await kit.drive.uploads.complete(late);
  expect(!finished.ok && finished.message).toMatch(STOPPED);
});

test("a folder removed just as an upload starts is refused, and R2 is left with nothing", async () => {
  const docs = await folder("Docs");
  const object = kit.instance().object;
  const realExists = object.folderExists.bind(object);
  // The check at the start saw the folder, then it went.
  object.folderExists = () => true;
  await kit.drive.trash(docs.id);
  await kit.drive.deleteForever(docs.id);
  const aborted: string[] = [];
  const realCreate = kit.bucket.createMultipartUpload.bind(kit.bucket);
  kit.bucket.createMultipartUpload = async (key: string) => {
    const multipart = await realCreate(key);
    const realAbort = multipart.abort.bind(multipart);
    multipart.abort = async () => {
      aborted.push(key);
      return realAbort();
    };
    return multipart;
  };
  const started = await kit.drive.uploads.start({
    parentId: docs.id,
    name: "Late.pdf",
    size: 1,
    mimeType: "application/pdf",
    fingerprint: "late",
  });
  object.folderExists = realExists;
  expect(started).toMatchObject({ ok: false, status: 404 });
  expect(aborted).toHaveLength(1);
});

const MY_FILES = "4f0b1c7e-2d3a-4e5f-8a9b-0c1d2e3f4a5b" as DriveId;

async function withMyFiles(limit: number | null) {
  kit.directory.run(
    "INSERT INTO drives (id, kind, name, colour, owner_id, limit_bytes) VALUES (?, 'personal', 'My files', 1, ?, ?)",
    [MY_FILES, ALICE, limit],
  );
  kit.directory.run(
    "INSERT INTO drive_access (drive_id, user_id, role) VALUES (?, ?, 'manager')",
    [MY_FILES, ALICE],
  );
  return kit.open(await kit.grantFor(ALICE, MY_FILES));
}

const setOrgLimit = (bytes: number) =>
  kit.directory.run(
    "INSERT INTO org_settings (id, storage_limit_bytes) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET storage_limit_bytes = excluded.storage_limit_bytes",
    [bytes],
  );

const orgTotal = () =>
  (
    kit.directory
      .query("SELECT sum(used_bytes) AS total FROM drives")
      .get() as { total: number }
  ).total;

test("a move into a My files with no room is refused in plain words before anything moves", async () => {
  const mine = await withMyFiles(8);
  await upload("Mine.pdf", null, 5, mine);
  const file = await upload("Big.pdf", null, 4);

  expect(await kit.drive.move(file.id, mine, null)).toEqual({
    status: "overLimit",
    bytes: 4,
  });
  expect(await names()).toEqual(["Big.pdf"]);
  expect(await names(mine)).toEqual(["Mine.pdf"]);
  expect(usage(DRIVE_A)).toEqual({ bytes: 4, files: 1 });
  expect(usage(MY_FILES)).toEqual({ bytes: 5, files: 1 });
  expect((await kit.drive.rename(file.id, named("Still.pdf"))).status).toBe(
    "renamed",
  );
  expect(moveRefusal(await readStorageRoom(kit.d1, MY_FILES), 4)).toBe(
    "This is 4 bytes, and only 3 bytes is left in your 8 bytes limit for My files. Delete something there or ask your admin for more space.",
  );
});

test("a folder's whole size counts, and a move that exactly fits goes through", async () => {
  const mine = await withMyFiles(10);
  const docs = await folder("Docs");
  await upload("One.pdf", docs.id, 6);
  await upload("Two.pdf", docs.id, 5);
  expect(await kit.drive.move(docs.id, mine, null)).toEqual({
    status: "overLimit",
    bytes: 11,
  });
  await kit.drive.trash(
    (await kit.drive.list(docs.id, null))?.items[0]?.id as ItemId,
  );
  await kit.drive.emptyTrash();
  expect((await kit.drive.move(docs.id, mine, null)).status).toBe("moved");
  expect(usage(MY_FILES)).toEqual({ bytes: 5, files: 1 });
});

test("a team folder has no limit of its own, so a move into one isn't refused", async () => {
  const mine = await withMyFiles(5);
  const file = await upload("Mine.pdf", null, 5, mine);
  expect((await mine.move(file.id, kit.driveB, null)).status).toBe("moved");
  expect(usage(DRIVE_B)).toEqual({ bytes: 5, files: 1 });
  expect(usage(MY_FILES)).toEqual({ bytes: 0, files: 0 });
});

test("the organisation's limit doesn't refuse a move, however full it is", async () => {
  const mine = await withMyFiles(null);
  const file = await upload("Report.pdf", null, 5);
  setOrgLimit(5);
  expect(orgTotal()).toBe(5);
  expect((await kit.drive.move(file.id, mine, null)).status).toBe("moved");
  expect(orgTotal()).toBe(5);
  expect(usage(MY_FILES)).toEqual({ bytes: 5, files: 1 });
});

test("during a move D1 counts the bytes on both sides, then each side's exact total", async () => {
  const file = await upload("Report.pdf", null, 5);
  await upload("Stays.pdf", null, 2);
  expect(orgTotal()).toBe(7);

  const mend = receiverCommitsThenLosesAnswer();
  await kit.drive.move(file.id, kit.driveB, null);
  expect(usage(DRIVE_A).bytes).toBe(7);
  expect(usage(DRIVE_B).bytes).toBe(5);

  // The sender still holds its rows, so its own exact total counts them, rightly.
  later(2 * 60_000);
  await upload("Another.pdf", null, 1);
  expect(usage(DRIVE_A).bytes).toBe(8);
  await kit.drive.trash(
    (await kit.drive.list(null, null))?.items.find(
      (item) => item.name === "Another.pdf",
    )?.id as ItemId,
  );
  await kit.drive.emptyTrash();
  expect(usage(DRIVE_A).bytes).toBe(7);

  mend();
  const confirm = confirmNeverArrives();
  later(2 * 60_000);
  await kit.instance(DRIVE_A).object.alarm();
  expect(usage(DRIVE_A)).toEqual({ bytes: 2, files: 1 });
  expect(orgTotal()).toBe(7);

  confirm();
  later(2 * 60_000);
  await kit.instance(DRIVE_A).object.alarm();
  expect(usage(DRIVE_A)).toEqual({ bytes: 2, files: 1 });
  expect(usage(DRIVE_B)).toEqual({ bytes: 5, files: 1 });
  expect(orgTotal()).toBe(7);
});

test("an upload near a full organisation limit is refused during a move, and works after it", async () => {
  const file = await upload("Report.pdf", null, 5);
  setOrgLimit(6);
  const mend = receiverCommitsThenLosesAnswer();
  await kit.drive.move(file.id, kit.driveB, null);
  expect(orgTotal()).toBe(10);

  const refused = await kit.drive.uploads.start({
    parentId: null,
    name: "Small.pdf",
    size: 1,
    mimeType: "image/png",
    fingerprint: "small-refused",
  });
  expect(refused.ok).toBe(false);

  mend();
  await kit.fireAlarm();
  expect(orgTotal()).toBe(5);
  await upload("Small.pdf", null, 1);
  expect(orgTotal()).toBe(6);
  expect(usage(DRIVE_A)).toEqual({ bytes: 1, files: 1 });
  expect(usage(DRIVE_B)).toEqual({ bytes: 5, files: 1 });
});

// The object dies between its claim in D1 and adding the rows.
function receiverDiesAfterClaim(driveId: DriveId = DRIVE_B) {
  const instance = kit.instance(driveId);
  const real = instance.db.exec;
  instance.db.exec = (query, ...bindings) => {
    if (query.includes("INSERT INTO items")) throw new Error("killed");
    return real(query, ...bindings);
  };
  kit.restart(driveId);
  return () => {
    instance.db.exec = real;
    kit.restart(driveId);
  };
}

test("a crash after the receiver's claim can't let an upload past a full organisation", async () => {
  await upload("Stays.pdf", null, 4);
  const moving = await upload("Move.pdf", null, 6);
  const racing = await startUpload("Racing.pdf", null, 6, kit.drive);
  setOrgLimit(10);

  const mend = receiverDiesAfterClaim();
  expect((await kit.drive.move(moving.id, kit.driveB, null)).status).toBe(
    "pending",
  );
  expect(usage(DRIVE_A).bytes).toBe(10);
  expect(usage(DRIVE_B).bytes).toBe(6);

  // The receiver's alarm takes back its claim, and the sender's figure never moved.
  await kit.fireAlarm(DRIVE_B);
  expect(usage(DRIVE_A).bytes).toBe(10);
  expect(usage(DRIVE_B).bytes).toBe(0);
  expect(orgTotal()).toBe(10);

  const refused = await kit.drive.uploads.complete(racing);
  expect(refused.ok).toBe(false);
  const started = await kit.drive.uploads.start({
    parentId: null,
    name: "Slip.pdf",
    size: 6,
    mimeType: "image/png",
    fingerprint: "slip",
  });
  expect(started.ok).toBe(false);

  // The first wake-up clears the refused upload, and the second retries the move.
  mend();
  await kit.fireAlarm(DRIVE_A);
  await kit.fireAlarm(DRIVE_A);
  expect(await names()).toEqual(["Stays.pdf"]);
  expect(await names(kit.driveB)).toEqual(["Move.pdf"]);
  expect(usage(DRIVE_A)).toEqual({ bytes: 4, files: 1 });
  expect(usage(DRIVE_B)).toEqual({ bytes: 6, files: 1 });
  expect(orgTotal()).toBe(10);
});

test("a receiver claiming again after a crash counts the bytes once", async () => {
  const mine = await withMyFiles(6);
  const file = await upload("Report.pdf", null, 6);
  const mend = receiverDiesAfterClaim(MY_FILES);
  await kit.drive.move(file.id, mine, null);
  expect(usage(MY_FILES).bytes).toBe(6);

  // Its alarm hasn't run, so D1 still holds the first claim, which exactly fills the limit.
  mend();
  await kit.fireAlarm();
  expect(await names(mine)).toEqual(["Report.pdf"]);
  expect(usage(MY_FILES)).toEqual({ bytes: 6, files: 1 });
  expect(usage(DRIVE_A)).toEqual({ bytes: 0, files: 0 });
});

test("a move out of My files frees its room once the move ends", async () => {
  const mine = await withMyFiles(5);
  const file = await upload("Report.pdf", null, 5, mine);
  const mend = receiverCommitsThenLosesAnswer();
  await mine.move(file.id, kit.driveB, null);
  const during = await mine.uploads.start({
    parentId: null,
    name: "New.pdf",
    size: 5,
    mimeType: "image/png",
    fingerprint: "during",
  });
  expect(during.ok).toBe(false);

  mend();
  await kit.fireAlarm(MY_FILES);
  expect(usage(MY_FILES)).toEqual({ bytes: 0, files: 0 });
  await upload("New.pdf", null, 5, mine);
  expect(usage(MY_FILES)).toEqual({ bytes: 5, files: 1 });
});

test("a failed write of the sender's total after a move is retried by its alarm", async () => {
  const file = await upload("Report.pdf", null, 5);
  const mend = receiverCommitsThenLosesAnswer();
  await kit.drive.move(file.id, kit.driveB, null);
  mend();

  kit.d1Failures.usageWrites = true;
  later(2 * 60_000);
  await kit.instance(DRIVE_A).object.alarm();
  expect(await names()).toEqual([]);
  expect(usage(DRIVE_A).bytes).toBe(5);

  kit.d1Failures.usageWrites = false;
  await kit.fireAlarm();
  expect(usage(DRIVE_A)).toEqual({ bytes: 0, files: 0 });
  expect(orgTotal()).toBe(5);
});

test("a delivery stalled past the give-up can leave D1 high, never low, until the next exact total", async () => {
  await upload("Stays.pdf", null, 4);
  const moving = await upload("Move.pdf", null, 6);
  setOrgLimit(10);

  // The delivery is stuck just before its claim, and its caller has stopped listening.
  const receiver = kit.instance(DRIVE_B).object;
  const { storage } = (
    receiver as unknown as {
      ctx: { storage: { setAlarm: (at: number) => Promise<void> } };
    }
  ).ctx;
  const realSetAlarm = storage.setAlarm;
  let release = () => {};
  const reachedClaim = new Promise<void>((reached) => {
    storage.setAlarm = async (at) => {
      storage.setAlarm = realSetAlarm;
      await realSetAlarm(at);
      reached();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
  });
  const realReceive = receiver.receiveMove.bind(receiver);
  const deliveries: ReturnType<typeof realReceive>[] = [];
  receiver.receiveMove = async (move) => {
    if (deliveries.length === 0) deliveries.push(realReceive(move));
    throw new Error("connection lost");
  };
  await kit.drive.move(moving.id, kit.driveB, null);
  await reachedClaim;

  later(HOUR + 1000);
  await kit.instance(DRIVE_A).object.alarm();
  expect(usage(DRIVE_A).bytes).toBe(10);
  const { id: moveId } = kit
    .instance(DRIVE_A)
    .sqlite.query("SELECT id FROM moves_out")
    .get() as { id: string };

  // The tell arrives first, and the receiver's exact write after the claim fails.
  const told = receiver.abandonMoveIn(moveId, DRIVE_B);
  const db = kit.env.DB;
  kit.env.DB = new Proxy(db, {
    get(target, property) {
      if (property !== "prepare") return Reflect.get(target, property);
      return (query: string) => {
        const prepared = target.prepare(query);
        kit.d1Failures.usageWrites = true;
        return prepared;
      };
    },
  });
  release();
  expect(await deliveries[0]).toEqual({ status: "noDestination" });
  await told;
  kit.env.DB = db;

  expect(await names(kit.driveB)).toEqual([]);
  expect(usage(DRIVE_B).bytes).toBe(6);
  expect(usage(DRIVE_A).bytes).toBe(10);
  kit.d1Failures.usageWrites = false;

  await kit.fireAlarm(DRIVE_B);
  expect(usage(DRIVE_B)).toEqual({ bytes: 0, files: 0 });
  expect(usage(DRIVE_A)).toEqual({ bytes: 10, files: 2 });
  expect(orgTotal()).toBe(10);
  expect((await kit.drive.rename(moving.id, named("Kept.pdf"))).status).toBe(
    "renamed",
  );

  await kit.fireAlarm(DRIVE_A);
  expect(kit.instance(DRIVE_A).alarm).toBeNull();
  expect(usage(DRIVE_A)).toEqual({ bytes: 10, files: 2 });
});

test("a repeat of a delivery claims the space only once", async () => {
  const mine = await withMyFiles(5);
  const file = await upload("Report.pdf", null, 5);
  const mendAnswer = (() => {
    const object = kit.instance(MY_FILES).object;
    const real = object.receiveMove.bind(object);
    object.receiveMove = async (move) => {
      await real(move);
      throw new Error("connection lost");
    };
    return () => {
      object.receiveMove = real;
    };
  })();
  await kit.drive.move(file.id, mine, null);
  expect(usage(MY_FILES).bytes).toBe(5);
  mendAnswer();
  await kit.fireAlarm();
  expect(usage(MY_FILES)).toEqual({ bytes: 5, files: 1 });
  expect(usage(DRIVE_A)).toEqual({ bytes: 0, files: 0 });
});

test("restoring from Trash adds no bytes, so a limit can't refuse it", async () => {
  const mine = await withMyFiles(10);
  const file = await upload("Report.pdf", null, 10, mine);
  await mine.trash(file.id);
  kit.directory.run("UPDATE drives SET limit_bytes = 1 WHERE id = ?", [
    MY_FILES,
  ]);
  setOrgLimit(1);
  expect(usage(MY_FILES).bytes).toBe(10);
  expect((await mine.restore(file.id)).status).toBe("restored");
  expect(usage(MY_FILES)).toEqual({ bytes: 10, files: 1 });
});
