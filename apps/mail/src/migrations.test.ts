import { applyMigrations, migrationDigests } from "@cloudysuite/object-sql";
import { expect, test } from "bun:test";
import { OutgoingStore } from "./compose/store";
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
    "d9d7b5cf74c4852bf0ddf8e673194decfef9b1ae20b9bebc781fb635ea93248b",
  ]);
});

test("drafts an earlier build left empty stay out of the list, and ones with words stay in", () => {
  const { db } = createSqlDriver();
  applyMigrations(db, MIGRATIONS.slice(0, -1));
  const add = (
    id: string,
    mode: string,
    to: string,
    subject: string,
    html: string,
  ) =>
    db.exec(
      `INSERT INTO outgoing (id, state, revision, mode, parent_refs, from_address, from_name,
         to_addresses, cc_addresses, bcc_addresses, subject, html, body_text, include_quote, quote_designed,
         r2_prefix, updated_by, updated_by_name, updated_at)
       VALUES (?, 'draft', 1, ?, '[]', 'a@x.org', '', ?, '[]', '[]', ?, ?, '', 1, 0, 'p/', 'u', 'U', 1)`,
      id,
      mode,
      to,
      subject,
      html,
    );
  const pat = JSON.stringify([{ name: "Pat", address: "pat@x.org" }]);
  add("opened-reply", "reply", pat, "Re: Plans", "");
  add("cleared-reply", "reply", pat, "Re: Plans", "<br>");
  add("empty-new", "new", "[]", "", "<br>");
  add("written-reply", "reply", pat, "Re: Plans", "<p>Agreed</p>");
  add("written-new", "new", "[]", "Hello", "");
  applyMigrations(db, MIGRATIONS);

  const listed = new OutgoingStore(db, new MailboxStore(db)).list("u");
  expect(listed.map(({ id }) => id as string).sort()).toEqual([
    "written-new",
    "written-reply",
  ]);
});
