import { expect, test } from "bun:test";
import { MAX_MESSAGE_BYTES } from "../types";
import { type MboxItem, type MboxPosition, readMbox } from "./mbox";

const encoder = new TextEncoder();
const START: MboxPosition = { offset: 0, skipping: null };
const SEPARATOR = "From alice@example.org Mon Nov  2 10:00:00 2026";

const fileReader =
  (bytes: Uint8Array) => async (offset: number, length: number) =>
    bytes.subarray(offset, offset + length);

async function itemsOf(
  file: string | Uint8Array,
  options: { from?: MboxPosition; limit?: number } = {},
): Promise<MboxItem[]> {
  const bytes = typeof file === "string" ? encoder.encode(file) : file;
  const items: MboxItem[] = [];
  for await (const item of readMbox(
    fileReader(bytes),
    bytes.length,
    options.from ?? START,
    options.limit,
  )) {
    items.push(item);
  }
  return items;
}

const textsOf = (items: MboxItem[]) =>
  items.flatMap((item) =>
    item.kind === "message" ? [new TextDecoder().decode(item.raw)] : [],
  );

const message = (subject: string, body = "Hello.") =>
  `Subject: ${subject}\nFrom: a@example.org\n\n${body}\n`;

test("splits a file into messages and drops the blank line that closes each", async () => {
  const items = await itemsOf(
    `${SEPARATOR}\n${message("one")}\n${SEPARATOR}\n${message("two")}\n`,
  );
  expect(textsOf(items)).toEqual([message("one"), message("two")]);
});

test("handles CRLF files, keeping their line endings", async () => {
  const one = "Subject: one\r\n\r\nHello.\r\n";
  const items = await itemsOf(
    `${SEPARATOR}\r\n${one}\r\n${SEPARATOR}\r\n${one}`,
  );
  expect(textsOf(items)).toEqual([one, one]);
});

test("reads a Google Takeout separator and uses its date", async () => {
  const items = await itemsOf(
    `From 1459293856139043431@xxx Wed Feb 03 19:40:35 +0000 2016\r\nX-GM-THRID: 1\r\n\r\nHi\r\n`,
  );
  const [first] = items;
  expect(first).toMatchObject({
    kind: "message",
    fallbackDate: Date.UTC(2016, 1, 3, 19, 40, 35),
  });
});

test("undoes one level of >From escaping and leaves other > lines alone", async () => {
  const items = await itemsOf(
    `${SEPARATOR}\nSubject: x\n\n>From the top\n>>From quoted\n> From a quote\n>Fromage\nend\n`,
  );
  expect(textsOf(items)).toEqual([
    "Subject: x\n\nFrom the top\n>From quoted\n> From a quote\n>Fromage\nend\n",
  ]);
});

test("a body line starting From that is not a separator stays in the message", async () => {
  const body = [
    "From the desk of the director",
    "From here on, we are closed.",
    // Shaped like a separator, but no header follows it.
    "From alice@example.org Mon Nov  2 10:00:00 2026",
    "more words",
  ].join("\n");
  const items = await itemsOf(`${SEPARATOR}\n${message("x", body)}`);
  expect(textsOf(items)).toEqual([message("x", body)]);
});

test("gives the same messages at every read size, including across chunk boundaries", async () => {
  const padding = "x".repeat(70);
  const body = Array.from({ length: 40_000 }, (_, i) =>
    i % 100 === 0 ? `>From line ${i}` : `${i} ${padding}`,
  ).join("\n");
  const big = message("big", body);
  const file = `${SEPARATOR}\n${big}\n${SEPARATOR}\n${message("small")}\n`;
  expect(file.length).toBeGreaterThan(2 * 1024 * 1024);

  const items = await itemsOf(file);
  expect(textsOf(items)).toEqual([
    big.replaceAll(">From line", "From line"),
    message("small"),
  ]);
});

test("finds a separator cut in half by a read boundary", async () => {
  const READ = 1024 * 1024;
  const emptyBody = `${SEPARATOR}\n${message("first", "")}\n`.length;
  // Puts the boundary before, inside, and just after the next separator line.
  for (const shift of [0, 1, 3, 20, SEPARATOR.length, SEPARATOR.length + 5]) {
    const body = "y".repeat(READ - shift - emptyBody);
    const file = `${SEPARATOR}\n${message("first", body)}\n${SEPARATOR}\n${message("second")}`;
    expect(file.indexOf(`\n${SEPARATOR}`, 1) + 1).toBe(READ - shift);
    const items = await itemsOf(file);
    expect(textsOf(items)).toEqual([message("first", body), message("second")]);
  }
});

test("a message over the limit is listed and the next message still arrives", async () => {
  const huge = `${SEPARATOR}\nSubject: Holiday photos\nFrom: Bob <bob@example.org>\n\n${"p".repeat(3 * 1024 * 1024)}\n\n`;
  const items = await itemsOf(`${huge}${SEPARATOR}\n${message("after")}\n`, {
    limit: 1024 * 1024,
  });
  const unreadable = items.find((item) => item.kind === "unreadable");
  expect(unreadable).toMatchObject({
    reason: "tooLarge",
    start: 0,
    size: huge.length,
  });
  expect(unreadable?.kind === "unreadable" && unreadable.hint).toContain(
    "Holiday photos",
  );
  expect(textsOf(items)).toEqual([message("after")]);
});

test("a message over the default limit of 25 MiB is never yielded", async () => {
  const size = 40 * 1024 * 1024;
  const file = new Uint8Array(size).fill(0x70);
  file.set(encoder.encode(`${SEPARATOR}\nSubject: huge\n\n`));
  let largest = 0;
  for await (const item of readMbox(fileReader(file), size, START)) {
    if (item.kind === "message") largest = item.raw.byteLength;
  }
  expect(largest).toBe(0);
  expect(MAX_MESSAGE_BYTES).toBeLessThan(size);
});

test("resuming from a saved position while skipping lists the same item", async () => {
  const huge = `${SEPARATOR}\nSubject: huge\n\n${"p".repeat(4 * 1024 * 1024)}\n`;
  const file = `${huge}\n${SEPARATOR}\n${message("after")}`;
  const limit = 1024 * 1024;
  const bytes = encoder.encode(file);

  let saved: MboxPosition | null = null;
  for await (const item of readMbox(
    fileReader(bytes),
    bytes.length,
    START,
    limit,
  )) {
    if (item.kind === "skipping") {
      saved = item.next;
      break;
    }
  }
  expect(saved?.skipping).not.toBeNull();

  const items = await itemsOf(file, { from: saved!, limit });
  expect(items.find((item) => item.kind === "unreadable")).toMatchObject({
    reason: "tooLarge",
    start: 0,
    size: huge.length + 1,
  });
  expect(textsOf(items)).toEqual([message("after")]);
});

test("resuming from any message's next position gives the remaining messages", async () => {
  const subjects = ["a", "b", "c", "d"];
  const file = subjects
    .map((subject) => `${SEPARATOR}\n${message(subject)}\n`)
    .join("");
  const all = await itemsOf(file);
  const second = all[1]!;
  if (second.kind !== "message") throw new Error("expected a message");
  const rest = await itemsOf(file, { from: second.next });
  expect(textsOf(rest)).toEqual([message("c"), message("d")]);
});

test("a final message cut off midway is listed and not stored", async () => {
  const cut = `${SEPARATOR}\nSubject: Cut off\nFrom: a@example.org\n\nThis message sto`;
  const items = await itemsOf(`${SEPARATOR}\n${message("whole")}\n${cut}`);
  expect(textsOf(items)).toEqual([message("whole")]);
  const unreadable = items.at(-1)!;
  expect(unreadable).toMatchObject({ kind: "unreadable", reason: "truncated" });
  expect(unreadable.kind === "unreadable" && unreadable.hint).toContain(
    "Cut off",
  );
});

test("a final message cut off in its headers is listed and not stored", async () => {
  const items = await itemsOf(`${SEPARATOR}\nSubject: Cut off\n`);
  expect(items).toEqual([
    expect.objectContaining({ kind: "unreadable", reason: "truncated" }),
  ]);
});

test("a file with no separator is not an mbox", async () => {
  expect(await itemsOf("just some notes\nabout nothing\n")).toEqual([
    { kind: "notMbox" },
  ]);
  const garbage = crypto.getRandomValues(new Uint8Array(60_000));
  expect(await itemsOf(garbage)).toEqual([{ kind: "notMbox" }]);
  const large = new Uint8Array(3 * 1024 * 1024).fill(0x41);
  expect(await itemsOf(large)).toEqual([{ kind: "notMbox" }]);
});

test("text before the first separator is listed, and blank lines are ignored", async () => {
  const withText = await itemsOf(
    `Exported by a tool\n\n${SEPARATOR}\n${message("x")}`,
  );
  expect(withText[0]).toMatchObject({
    kind: "unreadable",
    reason: "notAnEmail",
  });
  expect(textsOf(withText)).toEqual([message("x")]);

  const blank = await itemsOf(`\n\n${SEPARATOR}\n${message("x")}`);
  expect(blank.map((item) => item.kind)).toEqual(["message"]);
});

test("8-bit bytes survive unchanged", async () => {
  const head = encoder.encode(`${SEPARATOR}\nSubject: x\n\n`);
  const body = Uint8Array.of(0xe9, 0xff, 0x00, 0x80, 0x0a);
  const file = new Uint8Array(head.length + body.length);
  file.set(head);
  file.set(body, head.length);
  const [item] = await itemsOf(file);
  if (item?.kind !== "message") throw new Error("expected a message");
  expect(new Uint8Array(item.raw).subarray(-5)).toEqual(body);
});
