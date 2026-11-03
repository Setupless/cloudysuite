import {
  afterEach,
  beforeEach,
  expect,
  jest,
  setSystemTime,
  test,
} from "bun:test";
import { applyMigrations } from "@cloudysuite/object-sql";
import { createSqlDriver } from "@cloudysuite/object-sql/test-driver";
import type { DriveId, UserId } from "@cloudysuite/access";
import type { DriveClient } from "./client";
import { MIGRATIONS } from "./migrations";
import { parseItemName } from "./names";
import { searchDrives, starredAcrossDrives } from "./across-drives";
import { SearchStore } from "./search-store";
import { DriveStore } from "./store";
import {
  ALICE,
  BOB,
  CAROL,
  createStorageTest,
  DRIVE_A,
  DRIVE_B,
} from "./test-support";
import { type FileItem, type FolderItem, type ItemId } from "./types";

type Kit = Awaited<ReturnType<typeof createStorageTest>>;
let kit: Kit;
let bob: DriveClient;
let carol: DriveClient;

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

const addToDrive = (role: string, userId: UserId = BOB, driveId = DRIVE_A) =>
  kit.directory.run(
    "INSERT OR REPLACE INTO drive_access (drive_id, user_id, role) VALUES (?, ?, ?)",
    [driveId, userId, role],
  );

const names = async (drive: DriveClient, text: string) =>
  (await drive.search(text, 50)).lines.map((line) => line.item.name).sort();

const opener = (userId: UserId) => async (driveId: DriveId) =>
  kit.open(await kit.grantFor(userId, driveId));

let marketing: FolderItem;
let launch: FolderItem;
let assets: FolderItem;
let board: FolderItem;
let brief: FileItem;
let hero: FileItem;
let salaries: FileItem;

// Marketing / Spring launch / brief report.png, .. / Assets / hero report.png,
// Marketing / Board papers / salaries report.png
beforeEach(async () => {
  kit = await createStorageTest();
  marketing = await folder("Marketing plans");
  launch = await folder("Spring launch", marketing.id);
  assets = await folder("Assets", launch.id);
  board = await folder("Board papers", marketing.id);
  brief = await upload("brief report.png", launch.id);
  hero = await upload("hero report.png", assets.id);
  salaries = await upload("salaries report.png", board.id);
  bob = kit.open(await kit.grantFor(BOB, DRIVE_A));
  carol = kit.open(await kit.grantFor(CAROL, DRIVE_A));
});

afterEach(() => {
  setSystemTime();
  jest.useRealTimers();
});

test("someone on the drive finds anything in it, with its whole location", async () => {
  const { lines } = await kit.drive.search("report", 50);
  expect(lines.map((line) => line.item.name).sort()).toEqual([
    "brief report.png",
    "hero report.png",
    "salaries report.png",
  ]);
  expect(lines.find((line) => line.item.id === hero.id)?.location).toEqual([
    "Marketing plans",
    "Spring launch",
    "Assets",
  ]);
});

test("a share holder finds only what's under their share, and sees no folder above it", async () => {
  await kit.drive.sharePeople(launch.id, [BOB], "view");
  const { lines } = await bob.search("report", 50);
  expect(lines.map((line) => line.item.name).sort()).toEqual([
    "brief report.png",
    "hero report.png",
  ]);
  expect(lines.find((line) => line.item.id === hero.id)?.location).toEqual([
    "Spring launch",
    "Assets",
  ]);
  expect(lines.find((line) => line.item.id === brief.id)?.location).toEqual([
    "Spring launch",
  ]);
  expect(JSON.stringify(lines)).not.toContain("Marketing plans");
});

test("a share's own item shows no parent, so its location holds nothing", async () => {
  await kit.drive.sharePeople(launch.id, [BOB], "view");
  const { lines } = await bob.search("spring", 50);
  expect(lines).toHaveLength(1);
  expect(lines[0]?.item.parentId).toBeNull();
  expect(lines[0]?.location).toEqual([]);
});

test("a sibling's name can't be found through a share on the folder beside it", async () => {
  await kit.drive.sharePeople(launch.id, [BOB], "edit");
  expect(await names(bob, "salaries")).toEqual([]);
  expect(await names(bob, "board")).toEqual([]);
  expect(await names(bob, "marketing")).toEqual([]);
  expect(await names(carol, "report")).toEqual([]);
});

test("a person with no share finds nothing, and neither does a share taken away", async () => {
  expect(await names(bob, "report")).toEqual([]);
  await kit.drive.sharePeople(launch.id, [BOB], "view");
  expect(await names(bob, "brief")).toEqual(["brief report.png"]);
  await kit.drive.unshare(launch.id, BOB);
  expect(await names(bob, "brief")).toEqual([]);
});

test("moving something out of a shared folder stops it being found through the share", async () => {
  await kit.drive.sharePeople(launch.id, [BOB], "view");
  await kit.drive.move(assets.id, kit.drive, board.id);
  expect(await names(bob, "hero")).toEqual([]);
  const { lines } = await kit.drive.search("hero", 50);
  expect(lines[0]?.location).toEqual([
    "Marketing plans",
    "Board papers",
    "Assets",
  ]);
});

test("a share with everyone isn't searchable, nor named above a person's own share", async () => {
  await kit.drive.setEveryone(marketing.id, true);
  expect(await names(bob, "report")).toEqual([]);
  expect((await bob.opened(brief.id))?.item.name).toBe("brief report.png");
  await kit.drive.sharePeople(launch.id, [BOB], "view");
  const { lines } = await bob.search("brief", 50);
  expect(lines[0]?.location).toEqual(["Spring launch"]);
  expect(await names(bob, "salaries")).toEqual([]);
});

test("Trash leaves search, a restore comes back, and deleting forever stays gone", async () => {
  await kit.drive.sharePeople(launch.id, [BOB], "view");
  await kit.drive.trash(launch.id);
  expect(await names(kit.drive, "hero")).toEqual([]);
  expect(await names(kit.drive, "spring")).toEqual([]);
  expect(await names(bob, "hero")).toEqual([]);
  await kit.drive.restore(launch.id);
  expect(await names(kit.drive, "hero")).toEqual(["hero report.png"]);
  expect(await names(bob, "hero")).toEqual(["hero report.png"]);

  await kit.drive.trash(hero.id);
  expect(await names(kit.drive, "hero")).toEqual([]);
  await kit.drive.deleteForever(hero.id);
  expect(await names(kit.drive, "hero")).toEqual([]);
  const index = kit
    .instance()
    .db.exec("SELECT rowid FROM item_search WHERE item_search MATCH 'hero'")
    .toArray();
  expect(index).toEqual([]);
});

test("a restore that has to number a name finds the new name", async () => {
  await kit.drive.trash(hero.id);
  await upload("hero report.png", assets.id);
  await kit.drive.restore(hero.id);
  expect(await names(kit.drive, "hero")).toEqual([
    "hero report (2).png",
    "hero report.png",
  ]);
  expect(await names(kit.drive, "2")).toEqual(["hero report (2).png"]);
});

test("a rename shows at once: the old name stops matching and the new one starts", async () => {
  await kit.drive.rename(brief.id, named("Quarterly plan.png"));
  expect(await names(kit.drive, "brief")).toEqual([]);
  expect(await names(kit.drive, "quarterly")).toEqual(["Quarterly plan.png"]);
  await kit.drive.rename(launch.id, named("Autumn launch"));
  const { lines } = await kit.drive.search("quarterly", 50);
  expect(lines[0]?.location).toEqual(["Marketing plans", "Autumn launch"]);
});

test("words match from their start, in any order, and each must be there", async () => {
  expect(await names(kit.drive, "Spr")).toEqual(["Spring launch"]);
  expect(await names(kit.drive, "laun spr")).toEqual(["Spring launch"]);
  expect(await names(kit.drive, "pring")).toEqual([]);
  expect(await names(kit.drive, "spring report")).toEqual([]);
});

test("case and accents don't matter, whichever way round", async () => {
  await upload("Été Résumé.png");
  await upload("Ñandú ДОКЛАД.png");
  await upload("Café menu.png");
  for (const text of ["ete", "ÉTÉ", "resu", "RÉSUMÉ", "résumé"]) {
    expect(await names(kit.drive, text)).toEqual(["Été Résumé.png"]);
  }
  for (const text of ["nandu", "ÑANDÚ", "доклад", "докл"]) {
    expect(await names(kit.drive, text)).toEqual(["Ñandú ДОКЛАД.png"]);
  }
  expect(await names(kit.drive, "café")).toEqual(["Café menu.png"]);
  expect(await names(kit.drive, "cafe")).toEqual(["Café menu.png"]);
});

test("no text reaches the index as syntax, and none can cause an error", async () => {
  const hostile = [
    "",
    "   ",
    '"',
    '""',
    '"unterminated',
    "*",
    "**",
    "report*",
    "NEAR(",
    "NEAR(a b)",
    "NEAR",
    "OR",
    "AND",
    "NOT",
    "a OR b",
    "report NOT brief",
    "name:report",
    "name : report",
    "{name}: report",
    "- report",
    "+",
    "^report",
    "(",
    ")",
    "report)",
    "'; DROP TABLE items; --",
    "\0",
    "report\0",
    "🎉",
    "́",
    "\ud83d",
    "𞤀𞤁", // Letters newer than the index's Unicode tables.
    "ab𞤀cd",
    "report 𞤀",
    "a ".repeat(500),
    "x".repeat(10_000),
  ];
  for (const text of hostile) {
    await expect(kit.drive.search(text, 50)).resolves.toBeDefined();
    await expect(bob.search(text, 50)).resolves.toBeDefined();
  }
  expect(await names(kit.drive, '"')).toEqual([]);
  expect(await names(kit.drive, "*")).toEqual([]);
  expect(await names(kit.drive, "report*")).toHaveLength(3);
  expect(await names(kit.drive, "name:report")).toEqual([]);
  expect(
    kit.instance().db.exec("SELECT count(*) AS n FROM items").toArray(),
  ).toEqual([{ n: 7 }]);
});

test("words that look like operators are just words", async () => {
  await upload("OR NOT AND.png");
  await upload("NEAR miss.png");
  expect(await names(kit.drive, "OR")).toEqual(["OR NOT AND.png"]);
  expect(await names(kit.drive, "NOT")).toEqual(["OR NOT AND.png"]);
  expect(await names(kit.drive, "NEAR(")).toEqual(["NEAR miss.png"]);
});

test("rows from before search existed are found, and stay in step afterwards", () => {
  const { db } = createSqlDriver();
  applyMigrations(db, MIGRATIONS.slice(0, 3));
  const insert = (
    id: string,
    parent: string | null,
    kind: string,
    name: string,
  ) =>
    db.exec(
      `INSERT INTO items (id, parent_id, kind, name, name_key, size, mime_type, r2_key, created_by, created_at, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'someone', 1, 1)`,
      id,
      parent,
      kind,
      name,
      name.toLowerCase(),
      kind === "file" ? 1 : null,
      kind === "file" ? "text/plain" : null,
      kind === "file" ? `key-${id}` : null,
    );
  insert("11111111-1111-4111-8111-111111111111", null, "folder", "Old Résumés");
  insert(
    "22222222-2222-4222-8222-222222222222",
    "11111111-1111-4111-8111-111111111111",
    "file",
    "Old invoice.txt",
  );
  // A row already in Trash when the migration ran is indexed too, and left out on reading.
  insert("33333333-3333-4333-8333-333333333333", null, "file", "Old bin.txt");
  db.exec(
    "UPDATE items SET trash_id = id, purge_at = 9 WHERE id = '33333333-3333-4333-8333-333333333333'",
  );
  applyMigrations(db, MIGRATIONS);

  const store = new DriveStore(db);
  const search = new SearchStore(db, store);
  const actor = { userId: ALICE, role: "manager" as const };
  const found = (text: string) =>
    search
      .search(actor, text, 50)
      .lines.map((line) => line.item.name)
      .sort();
  expect(found("old")).toEqual(["Old Résumés", "Old invoice.txt"]);
  expect(found("resumes")).toEqual(["Old Résumés"]);
  expect(found("bin")).toEqual([]);
  expect(search.search(actor, "invoice", 50).lines[0]?.location).toEqual([
    "Old Résumés",
  ]);
  store.rename({
    actor,
    driveId: DRIVE_A,
    id: "22222222-2222-4222-8222-222222222222" as ItemId,
    name: named("New bill.txt"),
    now: 2,
  });
  expect(found("invoice")).toEqual([]);
  expect(found("bill")).toEqual(["New bill.txt"]);
});

test("a person's whole limit says there is more", async () => {
  const { lines, more } = await kit.drive.search("report", 2);
  expect(lines).toHaveLength(2);
  expect(more).toBe(true);
  expect((await kit.drive.search("report", 3)).more).toBe(false);
});

test("moving to another drive moves what search finds", async () => {
  await kit.drive.move(launch.id, kit.driveB, null);
  expect(await names(kit.drive, "hero")).toEqual([]);
  expect(await names(kit.driveB, "hero")).toEqual(["hero report.png"]);
  const { lines } = await kit.driveB.search("hero", 50);
  expect(lines[0]?.location).toEqual(["Spring launch", "Assets"]);
});

test("searching everything names only drives the person is on", async () => {
  await upload("finance report.png", null, kit.driveB);
  addToDrive("viewer", BOB, DRIVE_B);
  await kit.drive.sharePeople(launch.id, [BOB], "view");
  const answer = await searchDrives(kit.d1, BOB, opener(BOB), "report");
  expect(answer.incomplete).toBe(false);
  const rows = Object.fromEntries(
    answer.rows.map((row) => [row.item.name, row.driveName]),
  );
  expect(rows).toEqual({
    "finance report.png": "Finance",
    "brief report.png": null,
    "hero report.png": null,
  });
});

test("searching everything doesn't open a drive shared only with everyone", async () => {
  await kit.drive.setEveryone(marketing.id, true);
  const asked: DriveId[] = [];
  const answer = await searchDrives(
    kit.d1,
    BOB,
    async (driveId) => {
      asked.push(driveId);
      return opener(BOB)(driveId);
    },
    "report",
  );
  expect(asked).toEqual([]);
  expect(answer.rows).toEqual([]);
});

test("one drive failing leaves the others' results and says so", async () => {
  await upload("finance report.png", null, kit.driveB);
  const answer = await searchDrives(
    kit.d1,
    ALICE,
    async (driveId) => {
      if (driveId === DRIVE_B) throw new Error("The object is unavailable");
      return opener(ALICE)(driveId);
    },
    "report",
  );
  expect(answer.incomplete).toBe(true);
  expect(answer.rows.map((row) => row.item.name).sort()).toEqual([
    "brief report.png",
    "hero report.png",
    "salaries report.png",
  ]);
});

const DEADLINE_MS = 5_000;

const stuckOn = (stuck: DriveId) => async (driveId: DriveId) => {
  const client = await opener(ALICE)(driveId);
  if (driveId !== stuck) return client;
  const never = () => new Promise<never>(() => {});
  return { ...client, search: never, starred: never };
};

// The drives that answer do so in microtasks, so the clock moves only once they have.
async function waited<Answer>(
  asking: Promise<Answer>,
): Promise<{ answer: Answer; afterMs: number }> {
  let answer: { value: Answer } | null = null;
  void asking.then((value) => {
    answer = { value };
  });
  let afterMs = 0;
  for (;;) {
    for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
    if (answer) return { answer: (answer as { value: Answer }).value, afterMs };
    if (afterMs > 60_000) throw new Error("It never answered.");
    jest.advanceTimersByTime(1_000);
    afterMs += 1_000;
  }
}

test("a drive that never answers leaves the others' results and says so", async () => {
  await upload("finance report.png", null, kit.driveB);
  jest.useFakeTimers();
  const { answer, afterMs } = await waited(
    searchDrives(kit.d1, ALICE, stuckOn(DRIVE_B), "report"),
  );
  expect(afterMs).toBe(DEADLINE_MS);
  expect(answer.incomplete).toBe(true);
  expect(answer.rows.map((row) => row.item.name).sort()).toEqual([
    "brief report.png",
    "hero report.png",
    "salaries report.png",
  ]);
});

test("a drive that never answers leaves the other stars and says so", async () => {
  await kit.drive.setStar(brief.id, true);
  jest.useFakeTimers();
  const { answer, afterMs } = await waited(
    starredAcrossDrives(kit.d1, ALICE, stuckOn(DRIVE_B)),
  );
  expect(afterMs).toBe(DEADLINE_MS);
  expect(answer.incomplete).toBe(true);
  expect(answer.rows.map((row) => row.item.name)).toEqual([brief.name]);
});

test("a refusal part way through isn't a failure", async () => {
  const answer = await searchDrives(
    kit.d1,
    ALICE,
    async (driveId) => {
      if (driveId === DRIVE_B) throw new Response(null, { status: 403 });
      return opener(ALICE)(driveId);
    },
    "report",
  );
  expect(answer.incomplete).toBe(false);
  expect(answer.rows).toHaveLength(3);
});

test("a whole page of many drives never asks more than a few at once", async () => {
  const extra = Array.from({ length: 12 }, () => crypto.randomUUID());
  for (const id of extra) {
    kit.directory.run(
      "INSERT INTO drives (id, kind, name, colour) VALUES (?, 'team', 'More', 1)",
      [id],
    );
    addToDrive("viewer", ALICE, id as DriveId);
  }
  let open = 0;
  let most = 0;
  const answer = await searchDrives(
    kit.d1,
    ALICE,
    async (driveId) => {
      const client = await opener(ALICE)(driveId);
      return {
        ...client,
        search: async (text: string, limit: number) => {
          open += 1;
          most = Math.max(most, open);
          await new Promise((resolve) => setTimeout(resolve, 1));
          const found = await client.search(text, limit);
          open -= 1;
          return found;
        },
      };
    },
    "report",
  );
  expect(answer.rows).toHaveLength(3);
  expect(most).toBeGreaterThan(1);
  expect(most).toBeLessThanOrEqual(5);
});

// Stars.

const starsOf = async (userId: UserId) =>
  (await starredAcrossDrives(kit.d1, userId, opener(userId))).rows
    .map((row) => row.item.name)
    .sort();

const indexRows = () =>
  kit.directory
    .query("SELECT user_id, drive_id, item_id FROM drive_shares")
    .all() as { user_id: string; drive_id: string; item_id: string }[];

test("a person who can only view can star, on the drive or through a share", async () => {
  addToDrive("viewer", BOB);
  const viewer = kit.open(await kit.grantFor(BOB, DRIVE_A));
  expect(await viewer.setStar(brief.id, true)).toEqual({ status: "done" });
  expect(await starsOf(BOB)).toEqual(["brief report.png"]);

  await kit.drive.sharePeople(launch.id, [CAROL], "view");
  expect(await carol.setStar(hero.id, true)).toEqual({ status: "done" });
  expect(await starsOf(CAROL)).toEqual(["hero report.png"]);
});

test("one person's stars aren't anyone else's, in any answer", async () => {
  addToDrive("viewer", BOB);
  const viewer = kit.open(await kit.grantFor(BOB, DRIVE_A));
  await kit.drive.setStar(brief.id, true);
  expect(await starsOf(ALICE)).toEqual(["brief report.png"]);
  expect(await starsOf(BOB)).toEqual([]);
  expect(await viewer.starIds()).toEqual([]);
  expect(await viewer.starred(50)).toEqual([]);
  expect(JSON.stringify(await viewer.sharesOn(brief.id))).not.toContain("star");
  expect(JSON.stringify(await viewer.opened(brief.id))).not.toContain("star");
  await viewer.setStar(hero.id, true);
  expect(await kit.drive.starIds()).toEqual([brief.id]);
});

test("someone who can't reach an item can't star it, and learns nothing", async () => {
  await kit.drive.sharePeople(launch.id, [BOB], "view");
  expect(await bob.setStar(salaries.id, true)).toEqual({ status: "noAccess" });
  const missing = crypto.randomUUID() as ItemId;
  expect(await bob.setStar(missing, true)).toEqual({ status: "noAccess" });
  expect(await bob.starIds()).toEqual([]);
});

test("starring twice is one star, and unstarring twice changes nothing", async () => {
  await kit.drive.setStar(brief.id, true);
  await kit.drive.setStar(brief.id, true);
  expect(await kit.drive.starIds()).toEqual([brief.id]);
  await kit.drive.setStar(brief.id, false);
  expect(await kit.drive.setStar(brief.id, false)).toEqual({ status: "done" });
  expect(await starsOf(ALICE)).toEqual([]);
});

test("Trash takes an item off the list and restoring brings it back", async () => {
  await kit.drive.setStar(hero.id, true);
  await kit.drive.trash(launch.id);
  expect(await starsOf(ALICE)).toEqual([]);
  expect(await kit.drive.setStar(hero.id, true)).toEqual({ status: "gone" });
  await kit.drive.restore(launch.id);
  expect(await starsOf(ALICE)).toEqual(["hero report.png"]);
});

test("losing access takes it off the list without an error, and getting it back returns it", async () => {
  await kit.drive.sharePeople(launch.id, [BOB], "view");
  await bob.setStar(brief.id, true);
  expect(await starsOf(BOB)).toEqual(["brief report.png"]);
  await kit.drive.unshare(launch.id, BOB);
  await expect(starsOf(BOB)).resolves.toEqual([]);
  expect(await bob.starred(50)).toEqual([]);
  await kit.drive.sharePeople(launch.id, [BOB], "view");
  expect(await starsOf(BOB)).toEqual(["brief report.png"]);
});

test("deleting forever removes the star's row", async () => {
  await kit.drive.setStar(hero.id, true);
  await kit.drive.trash(launch.id);
  await kit.drive.deleteForever(launch.id);
  expect(await starsOf(ALICE)).toEqual([]);
  expect(kit.instance().db.exec("SELECT * FROM stars").toArray()).toEqual([]);
});

test("a star doesn't follow an item to another drive", async () => {
  await kit.drive.setStar(hero.id, true);
  await kit.drive.move(launch.id, kit.driveB, null);
  expect(await starsOf(ALICE)).toEqual([]);
  expect(kit.instance().db.exec("SELECT * FROM stars").toArray()).toEqual([]);
  expect(await kit.driveB.starIds()).toEqual([]);
});

test("a star stays through a move within the drive", async () => {
  await kit.drive.setStar(hero.id, true);
  await kit.drive.move(hero.id, kit.drive, board.id);
  expect(await starsOf(ALICE)).toEqual(["hero report.png"]);
});

test("a star on something opened from a share with everyone finds its way to the list", async () => {
  await kit.drive.setEveryone(launch.id, true);
  await bob.setStar(brief.id, true);
  expect(indexRows()).toEqual([
    { user_id: BOB, drive_id: DRIVE_A, item_id: brief.id },
  ]);
  expect(await starsOf(BOB)).toEqual(["brief report.png"]);
  // It doesn't make the drive searchable, or put it in Shared with me.
  expect((await searchDrives(kit.d1, BOB, opener(BOB), "report")).rows).toEqual(
    [],
  );
  expect(await bob.sharedWith(50)).toEqual([]);

  await bob.setStar(brief.id, false);
  expect(indexRows()).toEqual([]);
});

test("taking a share away leaves the pointer of a star that still stands", async () => {
  await kit.drive.setEveryone(launch.id, true);
  await kit.drive.sharePeople(brief.id, [BOB], "view");
  await bob.setStar(brief.id, true);
  await kit.drive.unshare(brief.id, BOB);
  expect(indexRows()).toHaveLength(1);
  expect(await starsOf(BOB)).toEqual(["brief report.png"]);
});

test("a star retried by the alarm reaches the index after D1 was down", async () => {
  await kit.drive.setEveryone(launch.id, true);
  kit.d1Failures.shareIndex = true;
  expect(await bob.setStar(brief.id, true)).toEqual({ status: "done" });
  expect(indexRows()).toEqual([]);
  kit.d1Failures.shareIndex = false;
  await kit.fireAlarm();
  expect(indexRows()).toHaveLength(1);
});

test("deleting forever clears the pointer a star left in the index", async () => {
  await kit.drive.setEveryone(launch.id, true);
  await bob.setStar(brief.id, true);
  await kit.drive.trash(brief.id);
  await kit.drive.deleteForever(brief.id);
  expect(indexRows()).toEqual([]);
});

test("Starred lists files and folders, newest star first, each reaching only as far as allowed", async () => {
  setSystemTime(new Date(1000));
  await kit.drive.setStar(brief.id, true);
  setSystemTime(new Date(2000));
  await kit.drive.setStar(launch.id, true);
  setSystemTime();
  const { rows } = await starredAcrossDrives(kit.d1, ALICE, opener(ALICE));
  expect(rows.map((row) => row.item.name)).toEqual([
    "Spring launch",
    "brief report.png",
  ]);
  expect(rows.every((row) => row.canEdit && !row.shared)).toBe(true);

  await kit.drive.sharePeople(launch.id, [BOB], "view");
  await bob.setStar(launch.id, true);
  const [line] = await bob.starred(50);
  expect(line?.shared).toBe(true);
  expect(line?.canEdit).toBe(false);
  expect(line?.item.parentId).toBeNull();
});

test("one drive failing leaves the other stars and says so", async () => {
  await kit.drive.setStar(brief.id, true);
  const answer = await starredAcrossDrives(kit.d1, ALICE, async (driveId) => {
    if (driveId === DRIVE_B) throw new Error("The object is unavailable");
    return opener(ALICE)(driveId);
  });
  expect(answer.incomplete).toBe(true);
  expect(answer.rows).toHaveLength(1);
});

const foundIn = async (drive: DriveClient, text: string) =>
  (await drive.search(text, 50)).lines.map((line) => line.item.name);

test("rows arriving from another drive aren't found until they unlock", async () => {
  await upload("Zebra.png");
  const file = await upload("Yak.png");
  const object = kit.instance(DRIVE_B).object;
  const real = object.confirmMoveIn.bind(object);
  object.confirmMoveIn = () => {
    throw new Error("connection lost");
  };
  expect((await kit.drive.move(file.id, kit.driveB, null)).status).toBe(
    "moved",
  );

  expect(await foundIn(kit.drive, "yak")).toEqual([]);
  expect(await foundIn(kit.driveB, "yak")).toEqual([]);
  // The list still shows it to someone on the drive, so it can be seen arriving.
  expect(await kit.driveB.file(file.id)).not.toBeNull();

  object.confirmMoveIn = real;
  kit.restart(DRIVE_A);
  await kit.fireAlarm();
  expect(await foundIn(kit.driveB, "yak")).toEqual(["Yak.png"]);
  expect(await foundIn(kit.drive, "yak")).toEqual([]);
});

test("a move given up is found where it stayed, and leaves nothing behind where it was going", async () => {
  const file = await upload("Yak.png");
  await kit.drive.setStar(file.id, true);
  const object = kit.instance(DRIVE_B).object;
  const real = object.receiveMove.bind(object);
  object.receiveMove = async (move) => {
    await real(move);
    throw new Error("connection lost");
  };
  await kit.drive.move(file.id, kit.driveB, null);

  // Both drives hold a row now, and only the one still answering for it is found.
  expect(await foundIn(kit.drive, "yak")).toEqual(["Yak.png"]);
  expect(await foundIn(kit.driveB, "yak")).toEqual([]);
  // Anyone who can open the arriving row can star it, and it goes with the row.
  expect((await kit.driveB.setStar(file.id, true)).status).toBe("done");

  setSystemTime(new Date(Date.now() + 60 * 60 * 1000 + 1000));
  await kit.instance(DRIVE_A).object.alarm();
  object.receiveMove = real;
  await kit.instance(DRIVE_A).object.alarm();

  expect(await foundIn(kit.drive, "yak")).toEqual(["Yak.png"]);
  expect(await foundIn(kit.driveB, "yak")).toEqual([]);
  expect(await kit.driveB.starIds()).toEqual([]);
  expect(await kit.drive.starIds()).toEqual([file.id]);
  expect((await kit.drive.starred(10)).map((line) => line.item.id)).toEqual([
    file.id,
  ]);
  // A later rename must not find a row the index has lost track of.
  await kit.drive.rename(file.id, named("Ox.png"));
  expect(await foundIn(kit.drive, "ox")).toEqual(["Ox.png"]);
});

test("a move the other drive refuses keeps its star and what search finds", async () => {
  const file = await upload("Yak.png");
  await upload("Yak.png", null, kit.driveB);
  await kit.drive.setStar(file.id, true);
  expect((await kit.drive.move(file.id, kit.driveB, null)).status).toBe(
    "nameTaken",
  );
  expect(await foundIn(kit.drive, "yak")).toEqual(["Yak.png"]);
  expect(await kit.drive.starIds()).toEqual([file.id]);
});
