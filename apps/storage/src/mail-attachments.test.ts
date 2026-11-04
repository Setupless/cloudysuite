import { afterEach, beforeEach, expect, test } from "bun:test";
import type { MailboxId, UserId } from "@cloudysuite/access";
import { partCountFor } from "@cloudysuite/transfer";
import {
  createTestEnv,
  MAILBOX_A,
  MAILBOX_B,
} from "../../mail/src/test-support";
import { testWorkerEnv } from "../../../src/db/test-database";
import { ALICE, BOB, createStorageTest } from "./test-support";

const { ingest } = await import("../../mail/src/ingest");
const { listMailAttachments, MAIL_OFF, saveMailAttachment } =
  await import("./mail-attachments");

type Fixture = Awaited<ReturnType<typeof createFixture>>;
let fixture: Fixture;
let nextMessage = 0;

const CRLF = "\r\n";
const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

type Part = {
  filename?: string;
  rawFilenameHeader?: string;
  type?: string;
  inline?: boolean;
  bytes?: Uint8Array;
};

function mailWith(
  parts: Part[],
  options: { from?: string; date?: string } = {},
): ArrayBuffer {
  nextMessage += 1;
  const lines = [
    `From: ${options.from ?? "Tom Okafor <tom@example.org>"}`,
    "To: Alice <alice@example.com>",
    `Subject: Message ${nextMessage}`,
    `Date: ${options.date ?? "Mon, 02 Nov 2026 10:00:00 +0000"}`,
    `Message-ID: <m${nextMessage}@example.org>`,
    'Content-Type: multipart/mixed; boundary="edge"',
    "",
    "--edge",
    "Content-Type: text/plain",
    "",
    "See attached.",
  ];
  for (const part of parts) {
    const filename = part.rawFilenameHeader ?? `"${part.filename ?? "a.pdf"}"`;
    lines.push(
      "--edge",
      `Content-Type: ${part.type ?? "application/pdf"}`,
      `Content-Disposition: ${part.inline ? "inline" : "attachment"}; filename=${filename}`,
      ...(part.inline ? ["Content-ID: <logo@example.org>"] : []),
      "Content-Transfer-Encoding: base64",
      "",
      toBase64(part.bytes ?? new TextEncoder().encode("file bytes")),
    );
  }
  lines.push("--edge--", "");
  return new TextEncoder().encode(lines.join(CRLF)).buffer as ArrayBuffer;
}

async function createFixture() {
  const storage = await createStorageTest();
  const mail = createTestEnv(storage.d1);
  (mail.env as { BUCKET: unknown }).BUCKET = storage.bucket;
  Object.assign(testWorkerEnv, mail.env, {
    DB: storage.d1,
    BUCKET: storage.bucket,
    DRIVE: storage.env.DRIVE,
  });
  for (const [id, name] of [
    [MAILBOX_A, "Alice"],
    [MAILBOX_B, "Support"],
  ] as const) {
    storage.directory.run(
      "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'personal', ?)",
      [id, name],
    );
  }
  const allow = (user: UserId, mailbox: MailboxId) =>
    storage.directory.run(
      "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, 'member')",
      [mailbox, user],
    );
  allow(ALICE, MAILBOX_A);

  const deliver = async (raw: ArrayBuffer, mailboxId = MAILBOX_A) => {
    const result = await ingest(mail.env, {
      mailboxId,
      raw,
      source: "inbound",
      envelope: { from: "tom@example.org", to: "alice@example.com" },
    });
    if (result.status !== "stored") throw new Error(result.status);
    return result.messageId;
  };

  const myDrive = () =>
    storage.directory
      .query("SELECT id, used_bytes, file_count FROM drives WHERE owner_id = ?")
      .get(ALICE) as {
      id: string;
      used_bytes: number;
      file_count: number;
    } | null;

  return { ...storage, mail, allow, deliver, myDrive };
}

async function myFiles() {
  const drive = fixture.myDrive();
  if (!drive) return [];
  const { grantFor, open } = fixture;
  const client = open(await grantFor(ALICE, drive.id as never));
  return (await client.list(null, null))?.items ?? [];
}

async function failureOf(run: Promise<unknown>) {
  const thrown = await run.then(
    () => null,
    (failure) => failure,
  );
  if (!(thrown instanceof Response)) throw thrown ?? new Error("Not refused");
  return {
    status: thrown.status,
    message: ((await thrown.json()) as { message: string }).message,
  };
}

async function onlyRow(userId = ALICE) {
  const rows = await listMailAttachments(userId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

beforeEach(async () => {
  fixture = await createFixture();
});

afterEach(() => {
  fixture.bucket.failGets = false;
});

test("it shows the sender, the name, and the type, newest first and at most five", async () => {
  for (const day of [1, 2, 3, 4, 5, 6, 7]) {
    await fixture.deliver(mailWith([{ filename: `File ${day}.pdf` }]));
  }
  const rows = await listMailAttachments(ALICE);
  expect(rows.map((row) => row.name)).toEqual([
    "File 7.pdf",
    "File 6.pdf",
    "File 5.pdf",
    "File 4.pdf",
    "File 3.pdf",
  ]);
  expect(rows[0]).toMatchObject({
    sender: "Tom Okafor",
    mimeType: "application/pdf",
    saved: false,
  });
});

test("the five newest are chosen across every mailbox the person can reach", async () => {
  fixture.allow(ALICE, MAILBOX_B);
  await fixture.deliver(mailWith([{ filename: "Mine.pdf" }]));
  await fixture.deliver(mailWith([{ filename: "Shared.pdf" }]), MAILBOX_B);
  const names = (await listMailAttachments(ALICE)).map((row) => row.name);
  expect(names.sort()).toEqual(["Mine.pdf", "Shared.pdf"]);
});

test("a sender with only an address is shown by that address", async () => {
  await fixture.deliver(mailWith([{}], { from: "events@harbourhall.example" }));
  expect((await onlyRow()).sender).toBe("events@harbourhall.example");
});

test("mail in a mailbox the person can't reach is not listed", async () => {
  await fixture.deliver(mailWith([{ filename: "Private.pdf" }]));
  expect(await listMailAttachments(BOB)).toEqual([]);
});

test.each(["spam", "trash"] as const)(
  "mail moved to %s is left out, and can't be saved",
  async (folder) => {
    const messageId = await fixture.deliver(mailWith([{}]));
    const row = await onlyRow();
    await fixture.mail
      .instanceOf(MAILBOX_A)
      .object.moveToFolder({ messageIds: [messageId] }, folder);
    expect(await listMailAttachments(ALICE)).toEqual([]);
    const refused = await failureOf(saveMailAttachment(ALICE, row));
    expect(refused.status).toBe(404);
    expect(await myFiles()).toEqual([]);
  },
);

test("an inline image such as a signature logo is left out, and can't be saved by its id", async () => {
  await fixture.deliver(
    mailWith([
      { filename: "logo.png", type: "image/png", inline: true },
      { filename: "Report.pdf" },
    ]),
  );
  const row = await onlyRow();
  expect(row.name).toBe("Report.pdf");
  const refused = await failureOf(
    saveMailAttachment(ALICE, {
      ...row,
      attachmentId: (row.attachmentId - 1) as typeof row.attachmentId,
    }),
  );
  expect(refused.status).toBe(404);
});

test("saving copies the same bytes into My files and counts towards its usage", async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(4096));
  await fixture.deliver(mailWith([{ filename: "Report.pdf", bytes }]));
  await saveMailAttachment(ALICE, await onlyRow());

  const [item] = await myFiles();
  expect(item).toMatchObject({ kind: "file", name: "Report.pdf" });
  const client = fixture.open(
    await fixture.grantFor(ALICE, fixture.myDrive()!.id as never),
  );
  const download = await client.download(item!.id);
  expect(
    new Uint8Array(await new Response(await download!.read()).arrayBuffer()),
  ).toEqual(bytes);
  expect(fixture.myDrive()).toMatchObject({
    used_bytes: bytes.byteLength,
    file_count: 1,
  });
  expect((await onlyRow()).saved).toBe(true);
});

test("a large attachment is saved in parts and arrives whole", async () => {
  const bytes = new Uint8Array(18_000_000).map((_, index) => index % 251);
  expect(partCountFor(bytes.byteLength)).toBe(2);
  await fixture.deliver(mailWith([{ filename: "Big.bin", bytes }]));
  await saveMailAttachment(ALICE, await onlyRow());

  const [item] = await myFiles();
  const client = fixture.open(
    await fixture.grantFor(ALICE, fixture.myDrive()!.id as never),
  );
  const download = await client.download(item!.id);
  expect(
    Bun.hash(await new Response(await download!.read()).arrayBuffer()),
  ).toBe(Bun.hash(bytes));
});

test("saving twice stores one file", async () => {
  await fixture.deliver(mailWith([{}]));
  const row = await onlyRow();
  await saveMailAttachment(ALICE, row);
  await saveMailAttachment(ALICE, row);
  expect(await myFiles()).toHaveLength(1);
  expect(fixture.myDrive()?.file_count).toBe(1);
});

test("a double click stores one file and tells the second click why it did nothing", async () => {
  await fixture.deliver(mailWith([{}]));
  const row = await onlyRow();
  const results = await Promise.allSettled([
    saveMailAttachment(ALICE, row),
    saveMailAttachment(ALICE, row),
  ]);
  const refused = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as Response] : [],
  );
  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  expect(refused.every((failure) => failure.status === 409)).toBe(true);
  await saveMailAttachment(ALICE, row);
  expect(await myFiles()).toHaveLength(1);
});

test("a crash after the file was made, before it was marked saved, doesn't make a second file", async () => {
  await fixture.deliver(mailWith([{}]));
  const row = await onlyRow();
  await saveMailAttachment(ALICE, row);
  fixture.directory.run(
    "UPDATE saved_mail_attachments SET saved_at = NULL, claimed_until = 0",
  );
  expect((await onlyRow()).saved).toBe(false);
  await saveMailAttachment(ALICE, row);
  expect(await myFiles()).toHaveLength(1);
  expect((await onlyRow()).saved).toBe(true);
});

test("a save that failed part way can be tried again and stores one file", async () => {
  await fixture.deliver(mailWith([{}]));
  const row = await onlyRow();
  fixture.bucket.failGets = true;
  const logged = console.error;
  console.error = () => {};
  const refused = await failureOf(saveMailAttachment(ALICE, row));
  console.error = logged;
  fixture.bucket.failGets = false;
  expect(refused.status).toBe(500);
  expect(refused.message).toContain("Try again");
  expect((await onlyRow()).saved).toBe(false);
  await saveMailAttachment(ALICE, row);
  expect(await myFiles()).toHaveLength(1);
});

test("a save that's still running holds the attachment, and one that crashed lets go in time", async () => {
  await fixture.deliver(mailWith([{}]));
  const row = await onlyRow();
  await saveMailAttachment(ALICE, row);
  fixture.directory.run(
    "UPDATE saved_mail_attachments SET saved_at = NULL, claimed_until = ?",
    [Date.now() + 60_000],
  );
  expect((await failureOf(saveMailAttachment(ALICE, row))).status).toBe(409);
  fixture.directory.run("UPDATE saved_mail_attachments SET claimed_until = ?", [
    Date.now() - 1,
  ]);
  await saveMailAttachment(ALICE, row);
  expect(await myFiles()).toHaveLength(1);
});

test("someone removed from a mailbox can't save from it, even with a row they saw", async () => {
  await fixture.deliver(mailWith([{}]));
  const row = await onlyRow();
  fixture.directory.run("DELETE FROM mailbox_access WHERE user_id = ?", [
    ALICE,
  ]);
  const refused = await failureOf(saveMailAttachment(ALICE, row));
  expect(refused.status).toBe(403);
  expect(refused.message).toContain("don't have access");
  expect(await listMailAttachments(ALICE)).toEqual([]);
  expect(fixture.myDrive()).toBeNull();
});

test("a person banned after seeing a row can't save it", async () => {
  await fixture.deliver(mailWith([{}]));
  const row = await onlyRow();
  fixture.directory.run("UPDATE user SET banned = 1 WHERE id = ?", [ALICE]);
  expect((await failureOf(saveMailAttachment(ALICE, row))).status).toBe(403);
});

test("someone can't save another mailbox's attachment by asking with its ids", async () => {
  await fixture.deliver(mailWith([{}]));
  const row = await onlyRow();
  expect((await failureOf(saveMailAttachment(BOB, row))).status).toBe(403);
});

test("with Mail off nothing is listed and a save is refused in plain words", async () => {
  await fixture.deliver(mailWith([{}]));
  const row = await onlyRow();
  fixture.directory.run(
    "INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)",
  );
  expect(await listMailAttachments(ALICE)).toEqual([]);
  const refused = await failureOf(saveMailAttachment(ALICE, row));
  expect(refused).toEqual({ status: 403, message: MAIL_OFF });
  expect(await myFiles()).toEqual([]);
});

test("a mailbox that fails to answer leaves out only that mailbox", async () => {
  fixture.allow(ALICE, MAILBOX_B);
  await fixture.deliver(mailWith([{ filename: "Fine.pdf" }]));
  const broken = fixture.mail.instanceOf(MAILBOX_B).object;
  broken.recentAttachments = () => {
    throw new Error("Mailbox is unavailable");
  };
  const logged = console.error;
  console.error = () => {};
  try {
    expect((await onlyRow()).name).toBe("Fine.pdf");
  } finally {
    console.error = logged;
  }
});

test("no mailboxes and no attachments both list nothing", async () => {
  expect(await listMailAttachments(BOB)).toEqual([]);
  expect(await listMailAttachments(ALICE)).toEqual([]);
});

test("a save over a limit is refused in plain words, stores nothing, and can be tried again", async () => {
  await fixture.deliver(mailWith([{ bytes: new Uint8Array(1000) }]));
  const row = await onlyRow();
  // Makes My files, as the admin screen does, so it can carry a limit.
  await fixture.deliver(
    mailWith([{ filename: "Small.pdf", bytes: new Uint8Array(1) }]),
  );
  const small = (await listMailAttachments(ALICE))[0]!;
  await saveMailAttachment(ALICE, small);
  fixture.directory.run(
    "UPDATE drives SET limit_bytes = 100 WHERE owner_id = ?",
    [ALICE],
  );

  const refused = await failureOf(saveMailAttachment(ALICE, row));
  expect(refused.status).toBe(413);
  expect(refused.message).toMatch(/My files|storage/i);
  expect(refused.message).not.toMatch(/choose the file/i);
  expect(await myFiles()).toHaveLength(1);
  expect(
    (await listMailAttachments(ALICE)).find(
      (item) => item.attachmentId === row.attachmentId,
    )?.saved,
  ).toBe(false);

  fixture.directory.run(
    "UPDATE drives SET limit_bytes = NULL WHERE owner_id = ?",
    [ALICE],
  );
  await saveMailAttachment(ALICE, row);
  expect(await myFiles()).toHaveLength(2);
});

test("a limit reached while the bytes were on their way refuses at the end, and a retry stores one file", async () => {
  await fixture.deliver(mailWith([{ bytes: new Uint8Array(1000) }]));
  const row = await onlyRow();
  await fixture.deliver(
    mailWith([{ filename: "Small.pdf", bytes: new Uint8Array(1) }]),
  );
  await saveMailAttachment(ALICE, (await listMailAttachments(ALICE))[0]!);

  const directory = fixture.directory;
  const realRef = fixture.mail.instanceOf(MAILBOX_A).object.listedAttachmentRef;
  let reads = 0;
  fixture.mail.instanceOf(MAILBOX_A).object.listedAttachmentRef = function (
    this: unknown,
    ...args: Parameters<typeof realRef>
  ) {
    // The second read is the first part's, which comes after the check at the start.
    reads += 1;
    if (reads === 2) {
      directory.run("UPDATE drives SET limit_bytes = 100 WHERE owner_id = ?", [
        ALICE,
      ]);
    }
    return realRef.apply(fixture.mail.instanceOf(MAILBOX_A).object, args);
  };

  const refused = await failureOf(saveMailAttachment(ALICE, row));
  expect(refused.status).toBe(413);
  expect(await myFiles()).toHaveLength(1);

  directory.run("UPDATE drives SET limit_bytes = NULL WHERE owner_id = ?", [
    ALICE,
  ]);
  await saveMailAttachment(ALICE, row);
  expect(await myFiles()).toHaveLength(2);
});

test("a hostile name and sender are cleaned, and saved under the clean name", async () => {
  await fixture.deliver(
    mailWith(
      [
        {
          rawFilenameHeader: `"..\\\\..\\\\in​voice‮txt.pdf"`,
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
      { from: `"Tom‮ <script>" <tom@example.org>` },
    ),
  );
  const row = await onlyRow();
  expect(row.name).not.toMatch(/[/\\​‮]/);
  expect(row.name.endsWith(".pdf")).toBe(true);
  expect(row.sender).toBe("Tom <script>");
  await saveMailAttachment(ALICE, row);
  const [item] = await myFiles();
  expect(item?.name).toBe(row.name);
});

test("an attachment that loses a name to one already there keeps both", async () => {
  await fixture.deliver(mailWith([{ filename: "Report.pdf" }]));
  await fixture.deliver(mailWith([{ filename: "Report.pdf" }]));
  const rows = await listMailAttachments(ALICE);
  await saveMailAttachment(ALICE, rows[0]!);
  await saveMailAttachment(ALICE, rows[1]!);
  expect((await myFiles()).map((item) => item.name).sort()).toEqual([
    "Report (2).pdf",
    "Report.pdf",
  ]);
});

test("after the saved copy is gone, the row offers the save again", async () => {
  await fixture.deliver(mailWith([{}]));
  const row = await onlyRow();
  await saveMailAttachment(ALICE, row);
  fixture.directory.run("UPDATE saved_mail_attachments SET item_id = ?", [
    crypto.randomUUID(),
  ]);
  expect((await onlyRow()).saved).toBe(false);
  await saveMailAttachment(ALICE, row);
  expect((await onlyRow()).saved).toBe(true);
});

test("the row survives the mail being deleted: the copy is a separate file", async () => {
  const messageId = await fixture.deliver(mailWith([{}]));
  const row = await onlyRow();
  await saveMailAttachment(ALICE, row);
  await fixture.mail
    .instanceOf(MAILBOX_A)
    .object.moveToFolder({ messageIds: [messageId] }, "trash");
  await fixture.mail
    .instanceOf(MAILBOX_A)
    .object.deleteForever({ messageIds: [messageId] });
  const [item] = await myFiles();
  const client = fixture.open(
    await fixture.grantFor(ALICE, fixture.myDrive()!.id as never),
  );
  expect(await client.download(item!.id)).not.toBeNull();
});

test("a saved copy in a drive the person can't reach doesn't count, and a new save lands in My files", async () => {
  await fixture.deliver(mailWith([{ filename: "Report.pdf" }]));
  const row = await onlyRow();
  await saveMailAttachment(ALICE, row);
  const mine = fixture.myDrive()!.id;

  const theirs = crypto.randomUUID();
  fixture.directory.run(
    "INSERT INTO drives (id, kind, name, colour) VALUES (?, 'team', 'Private', 1)",
    [theirs],
  );
  fixture.directory.run(
    "INSERT INTO drive_access (drive_id, user_id, role) VALUES (?, ?, 'manager')",
    [theirs, BOB],
  );
  const bob = fixture.open(await fixture.grantFor(BOB, theirs as never));
  const started = await bob.uploads.start({
    parentId: null,
    name: "Theirs.pdf",
    size: 0,
    mimeType: "application/pdf",
    fingerprint: "theirs",
  });
  if (!started.ok) throw new Error(started.message);
  const file = await bob.uploads.complete(started.value.id);
  if (!file.ok) throw new Error(file.message);

  fixture.directory.run(
    "UPDATE saved_mail_attachments SET drive_id = ?, item_id = ?",
    [theirs, file.value.id],
  );
  expect((await onlyRow()).saved).toBe(false);
  await saveMailAttachment(ALICE, row);
  expect(
    fixture.directory
      .query("SELECT drive_id FROM saved_mail_attachments")
      .get(),
  ).toEqual({ drive_id: mine });
  expect((await bob.list(null, null))?.items).toHaveLength(1);
});
