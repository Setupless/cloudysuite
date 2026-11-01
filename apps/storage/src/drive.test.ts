import { beforeEach, expect, test } from "bun:test";
import { checkDriveAccess, type UserId } from "@cloudysuite/access";
import { PART_BYTES, readUpTo } from "@cloudysuite/transfer";
import { parseItemName } from "./names";
import { ALICE, BOB, createStorageTest, DRIVE_A } from "./test-support";
import type { FileItem, FolderItem, ItemId, UploadView } from "./types";
import { downloadResponse, previewResponse } from "./file-responses";

type Kit = Awaited<ReturnType<typeof createStorageTest>>;
let kit: Kit;

beforeEach(async () => {
  kit = await createStorageTest();
});

const named = (raw: string) => {
  const parsed = parseItemName(raw);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed;
};

async function folder(name: string, parentId: ItemId | null = null) {
  const result = await kit.drive.createFolder(parentId, named(name));
  if (result.status !== "created") throw new Error(result.status);
  return result.item;
}

const partBody = (bytes: Uint8Array) => ({
  declaredBytes: bytes.byteLength,
  read: (limit: number) =>
    readUpTo(new Blob([bytes as BlobPart]).stream(), limit),
});

const details = (overrides: Record<string, unknown> = {}) => ({
  parentId: null,
  name: "Report.pdf",
  size: 5,
  mimeType: "application/pdf",
  fingerprint: "print",
  ...overrides,
});

async function started(input: Record<string, unknown>): Promise<UploadView> {
  const outcome = await kit.drive.uploads.start(input);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.value;
}

async function sent(upload: UploadView, bytes: Uint8Array) {
  for (let part = 1; (part - 1) * PART_BYTES < bytes.length; part += 1) {
    const slice = bytes.subarray((part - 1) * PART_BYTES, part * PART_BYTES);
    const outcome = await kit.drive.uploads.putPart(
      upload.id,
      part,
      partBody(slice),
    );
    if (!outcome.ok) throw new Error(outcome.message);
  }
}

async function upload(
  overrides: Record<string, unknown> = {},
  bytes = new Uint8Array([1, 2, 3, 4, 5]),
): Promise<FileItem> {
  const view = await started(details({ size: bytes.length, ...overrides }));
  await sent(view, bytes);
  const finished = await kit.drive.uploads.complete(view.id);
  if (!finished.ok) throw new Error(finished.message);
  return finished.value;
}

const names = async (parentId: ItemId | null = null) =>
  (await kit.drive.list(parentId, null))?.items.map((item) => item.name);

test("folders and files list with folders first, each in name order", async () => {
  await upload({ name: "b.txt" });
  await upload({ name: "A.txt" });
  await folder("zebra");
  await folder("Apple");
  expect(await names()).toEqual(["Apple", "zebra", "A.txt", "b.txt"]);
});

test("a folder says how many things it holds, and a file its size and type", async () => {
  const parent = await folder("Parent");
  await folder("Child", parent.id);
  await upload({ parentId: parent.id });
  const listing = await kit.drive.list(null, null);
  const shown = listing?.items[0] as FolderItem;
  expect(shown.contains).toBe(2);
  expect(listing?.contains).toBe(1);
  const inside = await kit.drive.list(parent.id, null);
  expect(inside?.folder?.name).toBe("Parent");
  const file = inside?.items.find((item) => item.kind === "file") as FileItem;
  expect(file.size).toBe(5);
  expect(file.mimeType).toBe("application/pdf");
});

test("a deep folder knows its way back to the root", async () => {
  const one = await folder("One");
  const two = await folder("Two", one.id);
  const three = await folder("Three", two.id);
  const listing = await kit.drive.list(three.id, null);
  expect(listing?.ancestors.map((item) => item.name)).toEqual(["One", "Two"]);
});

test("a folder id that doesn't exist or is a file isn't an empty folder", async () => {
  expect(await kit.drive.list("x" as ItemId, null)).toBeNull();
  const file = await upload();
  expect(await kit.drive.list(file.id, null)).toBeNull();
});

test("a long folder comes in pages with nothing missed or repeated", async () => {
  const expected: string[] = [];
  const db = kit.instance().db;
  for (let index = 0; index < 450; index += 1) {
    const kind = index < 225 ? "folder" : "file";
    const name = `${kind}-${String(index).padStart(3, "0")}`;
    expected.push(name);
    db.exec(
      `INSERT INTO items (id, kind, name, name_key, size, mime_type, r2_key, created_by, created_at, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'x', 1, 1)`,
      crypto.randomUUID(),
      kind,
      name,
      name,
      kind === "file" ? 1 : null,
      kind === "file" ? "text/plain" : null,
      kind === "file" ? "key" : null,
    );
  }
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    const listing = await kit.drive.list(null, cursor);
    seen.push(...(listing?.items ?? []).map((item) => item.name));
    cursor = listing?.nextCursor ?? null;
    if (cursor === null) break;
  }
  expect(seen).toEqual(expected);
});

test("a new folder with a taken name is refused, whatever its case or composition", async () => {
  await folder("Café");
  const result = await kit.drive.createFolder(null, named("CAFÉ"));
  expect(result).toEqual({ status: "nameTaken" });
  expect(await names()).toEqual(["Café"]);
});

test("the same name is free in a different folder", async () => {
  const parent = await folder("Parent");
  await folder("Parent", parent.id);
  expect(await names(parent.id)).toEqual(["Parent"]);
});

test("a new folder needs a parent that exists", async () => {
  const result = await kit.drive.createFolder(
    "00000000-0000-4000-8000-000000000000" as ItemId,
    named("Lost"),
  );
  expect(result).toEqual({ status: "noParent" });
});

test("an upload with a taken name keeps both", async () => {
  await upload();
  await upload({ fingerprint: "other" });
  await upload({ fingerprint: "third", name: "REPORT.pdf" });
  expect(await names()).toEqual(
    ["Report.pdf", "REPORT (3).pdf", "Report (2).pdf"].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    ),
  );
});

test("an upload can't take a folder's name either", async () => {
  await folder("Report.pdf");
  const file = await upload();
  expect(file.name).toBe("Report (2).pdf");
});

test("a file's bytes come back exactly, across a part boundary", async () => {
  const bytes = new Uint8Array(PART_BYTES * 2 + 123);
  bytes.fill(7, PART_BYTES);
  bytes[PART_BYTES * 2 + 122] = 9;
  const file = await upload({}, bytes);
  const response = await downloadResponse(kit.drive, file.id);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get("Content-Disposition")).toStartWith(
    "attachment;",
  );
  expect(response.headers.get("Content-Length")).toBe(String(bytes.length));
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
});

test("an empty file can be stored and downloaded", async () => {
  const file = await upload({}, new Uint8Array());
  expect(file.size).toBe(0);
  const response = await downloadResponse(kit.drive, file.id);
  expect((await response.arrayBuffer()).byteLength).toBe(0);
});

test("completing twice finds the item and changes nothing", async () => {
  const view = await started(details());
  await sent(view, new Uint8Array(5));
  const first = await kit.drive.uploads.complete(view.id);
  const row = kit.driveRow();
  const second = await kit.drive.uploads.complete(view.id);
  expect(first).toEqual(second);
  expect(first.ok && first.value.id).toBe(view.id);
  expect(await names()).toEqual(["Report.pdf"]);
  expect(kit.driveRow().file_count).toBe(1);
  expect(kit.driveRow().used_bytes).toBe(row.used_bytes);
});

test("when R2 already finished the file, completing checks the key and its size", async () => {
  const bytes = new Uint8Array(5);
  const view = await started(details());
  await sent(view, bytes);
  // R2 finished the file, and the crash came before the commit.
  const [[, upload]] = [...kit.bucket.uploads.entries()] as never;
  const { key } = upload as { key: string };
  kit.bucket.objects.set(key, bytes);
  kit.bucket.uploads.clear();

  const finished = await kit.drive.uploads.complete(view.id);
  expect(finished.ok).toBe(true);
  expect(await names()).toEqual(["Report.pdf"]);
});

test("when R2 lost the upload and the file isn't there, the person is told to start over", async () => {
  const view = await started(details());
  await sent(view, new Uint8Array(5));
  kit.bucket.uploads.clear();
  const finished = await kit.drive.uploads.complete(view.id);
  expect(finished.ok).toBe(false);
  if (!finished.ok) expect(finished.message).toContain("Choose the file again");
  expect(await names()).toEqual([]);
});

test("completing before every part arrived is refused", async () => {
  const bytes = new Uint8Array(PART_BYTES + 5);
  const view = await started(details({ size: bytes.length }));
  await kit.drive.uploads.putPart(
    view.id,
    1,
    partBody(bytes.subarray(0, PART_BYTES)),
  );
  const finished = await kit.drive.uploads.complete(view.id);
  expect(finished.ok).toBe(false);
});

test("the same file in the same folder resumes with the parts already stored", async () => {
  const bytes = new Uint8Array(PART_BYTES * 2 + 5);
  const first = await started(details({ size: bytes.length }));
  await kit.drive.uploads.putPart(
    first.id,
    2,
    partBody(bytes.subarray(PART_BYTES, PART_BYTES * 2)),
  );
  const again = await started(details({ size: bytes.length }));
  expect(again.id).toBe(first.id);
  expect(again.storedParts).toEqual([2]);
});

test("resuming needs the same folder, name, size, file, and person", async () => {
  const parent = await folder("Parent");
  const first = await started(details());
  for (const other of [
    details({ parentId: parent.id }),
    details({ name: "Other.pdf" }),
    details({ size: 6 }),
    details({ fingerprint: "different bytes" }),
  ]) {
    expect((await started(other)).id).not.toBe(first.id);
  }
  kit.directory.run(
    "INSERT INTO drive_access (drive_id, user_id, role) VALUES (?, ?, 'member')",
    [DRIVE_A, BOB],
  );
  const asBob = kit.open(await kit.grantFor(BOB, DRIVE_A));
  const bobs = await asBob.uploads.start(details());
  expect(bobs.ok && bobs.value.id).not.toBe(first.id);
});

test("a part of the wrong size or number is refused, and nothing is stored", async () => {
  const view = await started(details());
  const short = await kit.drive.uploads.putPart(
    view.id,
    1,
    partBody(new Uint8Array(4)),
  );
  expect(short.ok).toBe(false);
  const beyond = await kit.drive.uploads.putPart(
    view.id,
    2,
    partBody(new Uint8Array(5)),
  );
  expect(beyond.ok).toBe(false);
  expect((await started(details())).storedParts).toEqual([]);
});

test.each([
  [{ size: -1 }],
  [{ size: 1.5 }],
  [{ size: "5" }],
  [{ size: 100_000_000_001 }],
  [{ name: "a/b" }],
  [{ name: ".." }],
  [{ parentId: "../../other" }],
  [{ fingerprint: "" }],
  [{ parentId: "00000000-0000-4000-8000-000000000000" }],
])("starting an upload with %j is refused", async (overrides) => {
  expect((await kit.drive.uploads.start(details(overrides))).ok).toBe(false);
});

test("usage is written to D1 as absolute values after each change", async () => {
  await upload({}, new Uint8Array(100));
  expect(kit.driveRow()).toMatchObject({ used_bytes: 100, file_count: 1 });
  await upload({ name: "b" }, new Uint8Array(50));
  expect(kit.driveRow()).toMatchObject({ used_bytes: 150, file_count: 2 });
  kit.directory.run("UPDATE drives SET used_bytes = 9999");
  await folder("x");
  expect(kit.driveRow()).toMatchObject({ used_bytes: 150, file_count: 2 });
  expect(kit.instance().alarm).toBeNull();
});

test("an upload that hasn't finished doesn't count", async () => {
  const view = await started(details());
  await sent(view, new Uint8Array(5));
  expect(kit.driveRow()).toMatchObject({ used_bytes: 0, file_count: 0 });
});

test("a failed usage write leaves a flag that the alarm retries", async () => {
  kit.d1Failures.usageWrites = true;
  await upload({}, new Uint8Array(100));
  expect(kit.driveRow().used_bytes).toBe(0);
  expect(kit.instance().alarm).not.toBeNull();

  await kit.fireAlarm();
  expect(kit.driveRow().used_bytes).toBe(0);
  expect(kit.instance().alarm).not.toBeNull();

  kit.d1Failures.usageWrites = false;
  await kit.fireAlarm();
  expect(kit.driveRow()).toMatchObject({ used_bytes: 100, file_count: 1 });
  expect(kit.instance().alarm).toBeNull();
});

test("an upload untouched for 3 days is aborted and removed", async () => {
  const bytes = new Uint8Array(PART_BYTES + 5);
  const view = await started(details({ size: bytes.length }));
  await kit.drive.uploads.putPart(
    view.id,
    1,
    partBody(bytes.subarray(0, PART_BYTES)),
  );
  const alarm = kit.instance().alarm as number;
  expect(alarm).toBeGreaterThan(Date.now() + 2.9 * 24 * 60 * 60 * 1000);
  expect(kit.bucket.uploads.size).toBe(1);

  await kit.fireAlarm();
  expect(kit.bucket.uploads.size).toBe(0);
  expect(kit.instance().alarm).toBeNull();
  const again = await started(details({ size: bytes.length }));
  expect(again.id).not.toBe(view.id);
  expect(again.storedParts).toEqual([]);
});

test("removing a stopped upload also clears a file a crash left in R2, and no kept file", async () => {
  const kept = await upload({ name: "kept" });
  const view = await started(details());
  await sent(view, new Uint8Array(5));
  const [[, stopped]] = [...kit.bucket.uploads.entries()] as never;
  const { key } = stopped as { key: string };
  kit.bucket.objects.set(key, new Uint8Array(5));
  kit.bucket.uploads.clear();

  await kit.fireAlarm();
  expect(kit.bucket.objects.has(key)).toBe(false);
  const response = await downloadResponse(kit.drive, kept.id);
  expect(response.status).toBe(200);
});

test("a recently touched upload isn't removed by another's clean-up", async () => {
  const old = await started(details());
  const db = kit.instance().db;
  db.exec("UPDATE uploads SET touched_at = 1 WHERE id = ?", old.id);
  await kit.drive.uploads.start(details({ name: "new", fingerprint: "n" }));
  await kit.instance().object.alarm();
  const left = db
    .exec<{ name: string }>("SELECT name FROM uploads")
    .toArray()
    .map((row) => row.name);
  expect(left).toEqual(["new"]);
});

test("recent files come newest first and leave out folders", async () => {
  await folder("Not a file");
  const first = await upload({ name: "first" });
  await Bun.sleep(2);
  const second = await upload({ name: "second" });
  expect((await kit.drive.recent(4)).map((file) => file.id)).toEqual([
    second.id,
    first.id,
  ]);
  expect((await kit.drive.recent(1)).map((file) => file.id)).toEqual([
    second.id,
  ]);
});

test("someone not on a drive's list gets no grant, so can't open it", async () => {
  expect(await checkDriveAccess(kit.d1, BOB, DRIVE_A)).toEqual({
    allowed: false,
  });
  kit.directory.run("UPDATE user SET banned = 1 WHERE id = ?", [ALICE]);
  expect(await checkDriveAccess(kit.d1, ALICE, DRIVE_A)).toEqual({
    allowed: false,
  });
  const missing = "x" as UserId;
  expect((await checkDriveAccess(kit.d1, missing, DRIVE_A)).allowed).toBe(
    false,
  );
});

const HOSTILE_SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('/')</script></svg>`;
const HOSTILE_HTML = "<html><script>fetch('/')</script></html>";
const encoded = (text: string) => new TextEncoder().encode(text);

test.each([
  ["hostile.svg", "image/svg+xml", HOSTILE_SVG],
  ["hostile.html", "text/html", HOSTILE_HTML],
  ["hostile.html", "text/html; charset=utf-8", HOSTILE_HTML],
  ["hostile.xhtml", "application/xhtml+xml", HOSTILE_HTML],
  ["hostile.png", "image/svg+xml;image/png", HOSTILE_SVG],
  ["hostile.png", "IMAGE/SVG+XML", HOSTILE_SVG],
  ["no-type", "", HOSTILE_HTML],
])(
  "the inline route never serves %s claimed as %j",
  async (name, mimeType, content) => {
    const file = await upload({ name, mimeType }, encoded(content));
    const response = await previewResponse(kit.drive, file.id);
    expect(response.status).toBe(415);
    const text = await response.text();
    expect(text).not.toContain("<script");
    expect(response.headers.get("Content-Type")).toStartWith("text/plain");
  },
);

test("a page claiming to be a PNG is served as a PNG that can't be sniffed or run", async () => {
  const file = await upload(
    { name: "trick.png", mimeType: "image/png" },
    encoded(HOSTILE_HTML),
  );
  const response = await previewResponse(kit.drive, file.id);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("image/png");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
  expect(response.headers.get("Content-Disposition")).toBe("inline");
});

test.each(["image/png", "image/jpeg", "image/webp", "image/gif"])(
  "%s under the size limit is shown inline",
  async (mimeType) => {
    const file = await upload({ name: "picture", mimeType }, new Uint8Array(9));
    const response = await previewResponse(kit.drive, file.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(mimeType);
    expect((await response.arrayBuffer()).byteLength).toBe(9);
  },
);

test("an image over the size limit isn't shown inline", async () => {
  const bytes = new Uint8Array(5_000_001);
  const file = await upload({ name: "big.png", mimeType: "image/png" }, bytes);
  const response = await previewResponse(kit.drive, file.id);
  expect(response.status).toBe(415);
});

test("a hostile file still downloads, as plain bytes", async () => {
  for (const [name, mimeType, content] of [
    ["hostile.svg", "image/svg+xml", HOSTILE_SVG],
    ["hostile.html", "text/html", HOSTILE_HTML],
  ] as const) {
    const file = await upload({ name, mimeType }, encoded(content));
    const response = await downloadResponse(kit.drive, file.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("Content-Disposition")).toStartWith(
      "attachment;",
    );
    expect(await response.text()).toBe(content);
  }
});

test("a file that isn't there gives a plain answer on both routes", async () => {
  const missing = "00000000-0000-4000-8000-000000000000" as ItemId;
  for (const answer of [downloadResponse, previewResponse]) {
    const response = await answer(kit.drive, missing);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("This file is no longer available.");
  }
});

test("a folder can't be downloaded or previewed", async () => {
  const parent = await folder("Parent");
  expect((await downloadResponse(kit.drive, parent.id)).status).toBe(404);
  expect((await previewResponse(kit.drive, parent.id)).status).toBe(404);
});

test("people's ids are stored on what they added", async () => {
  const file = await upload();
  expect(file.createdBy).toBe(ALICE);
});
