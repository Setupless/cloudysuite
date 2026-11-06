import {
  applyMigrations,
  migrationDigests,
  type SqlDriver,
} from "@cloudysuite/object-sql";
import { expect, test } from "bun:test";
import type { MailboxId } from "@cloudysuite/access";
import { OutgoingStore } from "./compose/store";
import type { OutgoingId } from "./compose/types";
import { MIGRATIONS } from "./migrations";
import { MailboxStore } from "./store";
import { createSqlDriver } from "./test-support";

test("released migrations do not change", async () => {
  expect(await migrationDigests(MIGRATIONS)).toEqual([
    "64d76cc75a9c4fde8212b0e492e008d51d777bc8ff7397f0a6531049efb0bb04",
    "3521e4d8fa8b43d605caf0c3e41498076d269bbc497ac13f036966d1f90e2117",
    "e45855e92d326470830ff91d585e07ae4c4bb2ff1d7eb7709cab55c20382f42d",
    "3a0cc3e4d8dc3b4302a38bd5a8667cc13f545bbd91a4e1ced344d24748f08aef",
    "86db2189a19567c7e86ec85edc1ea89d7b5ec42b71e2c1a962ce807d6acfaf25",
    "188f4e4c9cac3ec0ce8b932c1d5a652605e04112058c08573d5c3919739b4dda",
    "7a916817e3983bb1710f4ffe263543ff52ba7810194fb2d02deb4ae709c9212b",
    "9b435c5b91ff3ed4f306f730e201edfd27cd63ccc943919ecdcaa444d09007fd",
    "6d1b882e15568f6f2408f1a7a1e2cb60f183f2dc7a13d720be4133218ae92f33",
    "c8dff5b5303899fbc630409d5a9d1dc740100c3d4c15c5e526ad2ab02b2da114",
    "0d7c2e566063933260d6a1a900bdc8360a342a849a442c3baf8585adb1e7c1c6",
    "c5732543fa70d8ea91bb23676b907f9c19fd3790e92a878ee66627bc30e14961",
    "043532f41c1a20e11fb77d1ad18409d192f367bf778e95a1ebd957205797f154",
  ]);
});

type Earlier = {
  revision: number;
  mode: string;
  to?: string;
  cc?: string;
  subject: string;
  html?: string;
};

const PAT = JSON.stringify([{ name: "Pat", address: "pat@x.org" }]);
const SAM = JSON.stringify([{ name: "Sam", address: "sam@x.org" }]);

// Before the migration that recorded what a reply opened with.
const BEFORE_PREFILL = 9;

function atEarlierVersion(rows: Record<string, Earlier>) {
  const { db } = createSqlDriver();
  applyMigrations(db, MIGRATIONS.slice(0, BEFORE_PREFILL));
  for (const [id, row] of Object.entries(rows)) {
    db.exec(
      `INSERT INTO outgoing (id, state, revision, mode, parent_refs, from_address, from_name,
         to_addresses, cc_addresses, bcc_addresses, subject, html, body_text, include_quote, quote_designed,
         r2_prefix, updated_by, updated_by_name, updated_at)
       VALUES (?, 'draft', ?, ?, '[]', 'a@x.org', '', ?, ?, '[]', ?, ?, '', 1, 0, ?, 'u', 'U', 1)`,
      id,
      row.revision,
      row.mode,
      row.to ?? "[]",
      row.cc ?? "[]",
      row.subject,
      row.html ?? "",
      `p/${id}/`,
    );
  }
  return db;
}

const carryFile = (db: SqlDriver, id: string) =>
  db.exec(
    `INSERT INTO outgoing_attachments (outgoing_id, filename, mime_type, size, r2_key)
     VALUES (?, 'plan.pdf', 'application/pdf', 1, ?)`,
    id,
    `p/${id}/forwarded/0`,
  );

const listedIn = (db: SqlDriver) =>
  new OutgoingStore(db, new MailboxStore(db))
    .list("u")
    .map(({ id }) => id as string)
    .sort();

test("a reply or forward an earlier build opened and nobody saved stays out of the list", () => {
  const db = atEarlierVersion({
    "opened-reply": {
      revision: 1,
      mode: "reply",
      to: PAT,
      subject: "Re: Plans",
    },
    "opened-forward": { revision: 1, mode: "forward", subject: "Fwd: Plans" },
    "empty-new": { revision: 1, mode: "new", subject: "", html: "<br>" },
    "written-reply": {
      revision: 2,
      mode: "reply",
      to: PAT,
      subject: "Re: Plans",
      html: "<p>Agreed</p>",
    },
    "written-new": { revision: 2, mode: "new", subject: "Hello" },
  });
  carryFile(db, "opened-forward");
  applyMigrations(db, MIGRATIONS);

  expect(listedIn(db)).toEqual(["written-new", "written-reply"]);
});

test("a saved reply or forward with no words keeps what someone added to it", () => {
  const db = atEarlierVersion({
    "forward-to-sam": {
      revision: 2,
      mode: "forward",
      to: SAM,
      subject: "Fwd: Plans",
    },
    "forward-new-subject": {
      revision: 2,
      mode: "forward",
      subject: "Have a look",
    },
    "reply-added-cc": {
      revision: 2,
      mode: "reply",
      to: PAT,
      cc: SAM,
      subject: "Re: Plans",
    },
    "reply-other-person": {
      revision: 3,
      mode: "replyAll",
      to: SAM,
      subject: "Re: Plans",
    },
    "reply-new-subject": {
      revision: 2,
      mode: "reply",
      to: PAT,
      subject: "Plans changed",
    },
  });
  carryFile(db, "forward-to-sam");
  applyMigrations(db, MIGRATIONS);

  const ids = [
    "forward-new-subject",
    "forward-to-sam",
    "reply-added-cc",
    "reply-new-subject",
    "reply-other-person",
  ];
  expect(listedIn(db)).toEqual(ids);

  // Opening one and leaving must not remove it either.
  const store = new OutgoingStore(db, new MailboxStore(db));
  for (const id of ids as OutgoingId[]) {
    const detail = store.detail(id, "u")!;
    const left = store.save({
      id,
      copyId: "00000000-0000-4000-8000-000000000000" as OutgoingId,
      mailboxId: "00000000-0000-4000-8000-00000000000a" as MailboxId,
      baseRevision: detail.revision,
      session: "s",
      written: false,
      fileComing: false,
      showing: [],
      whenLocked: "report",
      content: detail.content,
      plainText: "",
      editor: { id: "u", name: "U" },
      r2Prefix: `p/${id}/`,
      leaving: true,
    });
    expect(left.status).toBe("saved");
  }
  expect(listedIn(db)).toEqual(ids);
  const [{ files }] = db
    .exec<{ files: number }>(
      "SELECT COUNT(*) AS files FROM outgoing_attachments",
    )
    .toArray() as [{ files: number }];
  expect(files).toBe(1);
});
