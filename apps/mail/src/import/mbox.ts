import { decodeWords } from "postal-mime";
import { MAX_MESSAGE_BYTES } from "../types";
import type { UnreadableReason } from "./types";

// Reads mbox as mboxrd: a line of `>From `, with any number of `>`, loses one `>`.
// mboxrd is exact, because a writer adds one `>` to every such line. It is also the
// best reading of mboxo, which escapes only `From ` and cannot be undone exactly:
// there the rule restores every escaped line, and costs one `>` only on a body line
// that really began `>From `. Nothing in a file says which format it is.

export type MboxPosition = {
  // Always the start of a separator line unless `skipping` is set.
  offset: number;
  skipping: { start: number; midLine: boolean; hint: string } | null;
};

export type MboxItem =
  | {
      kind: "message";
      raw: ArrayBuffer;
      // The separator line's date, for a message with no usable Date header.
      fallbackDate: number | null;
      start: number;
      next: MboxPosition;
    }
  | {
      kind: "unreadable";
      reason: UnreadableReason;
      start: number;
      size: number;
      hint: string;
      next: MboxPosition;
    }
  // Saves progress through a message too large to hold, which may be many batches long.
  | { kind: "skipping"; next: MboxPosition }
  | { kind: "notMbox" };

export type RangeReader = (
  offset: number,
  length: number,
) => Promise<Uint8Array>;

const READ_BYTES = 1024 * 1024;
// A real file reaches its first separator long before this.
const NOT_MBOX_AFTER_BYTES = READ_BYTES;
// A separator is never longer than this, so a longer line needs no more looking at.
const LINE_HEAD_BYTES = 1024;
const SEPARATOR_DATE_BYTES = 64;
const HEADER_NAME_BYTES = 77;
const HINT_SOURCE_BYTES = 64 * 1024;
const HINT_LENGTH = 200;
// The blank line that closes a message in the file is not part of the message.
const SEPARATOR_BLANK_LINE_BYTES = 2;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const GREATER_THAN = 0x3e;
const COLON = 0x3a;
const CAPITAL_F = 0x46;
const FROM_SPACE = [0x46, 0x72, 0x6f, 0x6d, 0x20];

const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

// Matches only the end of the line, so the cost of a hostile line stays constant.
// Takes `Thu Jan  1 00:00:00 2015`, `Thu Jan 01 00:00:00 +0000 2015`, and the same
// with the zone after the year.
const SEPARATOR_DATE =
  /(?:^|\s)(?:[A-Z][a-z]{2} +)?([A-Z][a-z]{2}) +(\d{1,2}) +(\d{1,2}):(\d{2})(?::(\d{2}))? +(?:([+-]\d{4}) +|[A-Z]{2,5} +)?(\d{4})(?: +([+-]\d{4}))?\s*$/;

const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes);

const hasPrefix = (buffer: Uint8Array, start: number, prefix: number[]) =>
  prefix.every((byte, index) => buffer[start + index] === byte);

function parseSeparatorDate(line: Uint8Array): number | false {
  const tail = latin1(line.subarray(-SEPARATOR_DATE_BYTES));
  const match = SEPARATOR_DATE.exec(tail);
  if (!match) return false;
  const [, month, day, hour, minute, second, zoneBefore, year, zoneAfter] =
    match;
  const monthIndex = MONTHS.indexOf(month!);
  if (monthIndex === -1 || monthIndex % 3 !== 0) return false;
  const zone = zoneBefore ?? zoneAfter ?? "+0000";
  const offsetMinutes =
    (zone.startsWith("-") ? -1 : 1) *
    (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
  return (
    Date.UTC(
      Number(year),
      monthIndex / 3,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second ?? 0),
    ) -
    offsetMinutes * 60_000
  );
}

function looksLikeHeader(buffer: Uint8Array, start: number): boolean {
  const end = Math.min(buffer.length, start + HEADER_NAME_BYTES);
  for (let index = start; index < end; index += 1) {
    const byte = buffer[index]!;
    if (byte === COLON) return index > start;
    if (byte <= 0x20 || byte > 0x7e) return false;
  }
  return false;
}

function isEscapedFrom(buffer: Uint8Array, start: number, end: number) {
  let index = start;
  while (index < end && buffer[index] === GREATER_THAN) index += 1;
  return index > start && hasPrefix(buffer, index, FROM_SPACE);
}

function describe(head: Uint8Array): string {
  const text = new TextDecoder().decode(head);
  const headers = text.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const read = (name: string) => {
    const value = new RegExp(`^${name}:[ \\t]*(.*)$`, "im")
      .exec(headers)?.[1]
      ?.trim();
    if (!value) return null;
    try {
      return decodeWords(value);
    } catch {
      return value;
    }
  };
  const subject = read("Subject");
  const from = read("From");
  return [subject && `“${subject}”`, from && `from ${from}`]
    .filter(Boolean)
    .join(" ")
    .replace(/\p{Cc}+/gu, " ")
    .slice(0, HINT_LENGTH);
}

function hasHeaderEnd(bytes: Uint8Array): boolean {
  for (
    let index = bytes.indexOf(NEWLINE);
    index !== -1;
    index = bytes.indexOf(NEWLINE, index + 1)
  ) {
    const next = bytes[index + 1];
    if (next === NEWLINE) return true;
    if (next === CARRIAGE_RETURN && bytes[index + 2] === NEWLINE) return true;
  }
  return false;
}

type Building = {
  start: number;
  fallbackDate: number | null;
  runs: Uint8Array[];
  bytes: number;
};

// Splits bytes into messages without ever holding more than one message and one
// read. It works on bytes, because 8-bit mail is not valid in any one encoding.
class MboxSplitter {
  readonly #limit: number;
  #base: number;
  #carry: Uint8Array = new Uint8Array(0);
  #message: Building | null = null;
  #skipping: MboxPosition["skipping"];
  #midLine: boolean;
  #inPreamble: boolean;

  constructor(position: MboxPosition, limit: number) {
    this.#limit = limit;
    this.#base = position.offset;
    this.#skipping = position.skipping;
    this.#midLine = position.skipping?.midLine ?? false;
    this.#inPreamble = position.offset === 0;
  }

  push(chunk: Uint8Array, eof: boolean): MboxItem[] {
    const buffer = this.#joined(chunk);
    const items: MboxItem[] = [];
    let position = 0;
    let runStart = 0;

    const flush = (end: number) => {
      const message = this.#message;
      if (!message || end <= runStart) return;
      message.runs.push(buffer.subarray(runStart, end));
      message.bytes += end - runStart;
      if (message.bytes > this.#limit + SEPARATOR_BLANK_LINE_BYTES) {
        const head = joinRuns(message.runs, HINT_SOURCE_BYTES);
        this.#skipping = {
          start: message.start,
          midLine: false,
          hint: describe(head),
        };
        this.#message = null;
      }
    };

    scan: while (position < buffer.length) {
      if (this.#midLine) {
        const newline = buffer.indexOf(NEWLINE, position);
        if (newline === -1) {
          position = buffer.length;
          break;
        }
        position = newline + 1;
        this.#midLine = false;
        continue;
      }

      const first = buffer[position];
      if (first === CAPITAL_F || first === GREATER_THAN) {
        const newline = buffer.indexOf(NEWLINE, position);
        const lineEnd = newline === -1 ? buffer.length : newline + 1;
        if (
          newline === -1 &&
          !eof &&
          buffer.length - position < LINE_HEAD_BYTES
        ) {
          break scan;
        }

        if (first === GREATER_THAN) {
          if (isEscapedFrom(buffer, position, lineEnd)) {
            flush(position);
            runStart = position + 1;
          }
        } else if (
          lineEnd - position <= LINE_HEAD_BYTES &&
          hasPrefix(buffer, position, FROM_SPACE)
        ) {
          const line = buffer.subarray(position, lineEnd);
          const date = parseSeparatorDate(line);
          if (date !== false) {
            const nextNewline = buffer.indexOf(NEWLINE, lineEnd);
            const available = buffer.length - lineEnd;
            if (!eof && nextNewline === -1 && available < HEADER_NAME_BYTES) {
              break scan;
            }
            const absolute = this.#base + position;
            if (
              absolute === 0 ||
              looksLikeHeader(buffer, lineEnd) ||
              (eof && available === 0)
            ) {
              flush(position);
              const closed = this.#close(absolute, buffer, position);
              if (closed) items.push(closed);
              this.#message = {
                start: absolute,
                fallbackDate: date,
                runs: [],
                bytes: 0,
              };
              runStart = lineEnd;
              position = lineEnd;
              continue;
            }
          }
        }

        if (newline === -1) {
          position = buffer.length;
          this.#midLine = true;
          break;
        }
        position = lineEnd;
        continue;
      }

      const newline = buffer.indexOf(NEWLINE, position);
      if (newline === -1) {
        position = buffer.length;
        this.#midLine = true;
        break;
      }
      position = newline + 1;
    }

    flush(position);
    const scanned = this.#base + position;

    if (eof) {
      const closed = this.#closeAtEnd(scanned);
      if (closed) items.push(closed);
      return items;
    }

    this.#carry = buffer.subarray(position);
    this.#base = scanned;
    if (this.#inPreamble && scanned >= NOT_MBOX_AFTER_BYTES) {
      return [{ kind: "notMbox" }];
    }
    if (this.#skipping) {
      this.#skipping = { ...this.#skipping, midLine: this.#midLine };
      items.push({
        kind: "skipping",
        next: { offset: scanned, skipping: this.#skipping },
      });
    }
    return items;
  }

  #joined(chunk: Uint8Array): Uint8Array {
    if (this.#carry.length === 0) return chunk;
    const joined = new Uint8Array(this.#carry.length + chunk.length);
    joined.set(this.#carry);
    joined.set(chunk, this.#carry.length);
    return joined;
  }

  // Closes whatever precedes the separator at `absolute`.
  #close(
    absolute: number,
    buffer: Uint8Array,
    position: number,
  ): MboxItem | null {
    const next: MboxPosition = { offset: absolute, skipping: null };
    if (this.#inPreamble) {
      this.#inPreamble = false;
      if (absolute === 0) return null;
      const blank =
        this.#base === 0 &&
        buffer.subarray(0, position).every((byte) => byte <= 0x20);
      if (blank) return null;
      return {
        kind: "unreadable",
        reason: "notAnEmail",
        start: 0,
        size: absolute,
        hint: "",
        next,
      };
    }
    if (this.#skipping) {
      const { start, hint } = this.#skipping;
      this.#skipping = null;
      return {
        kind: "unreadable",
        reason: "tooLarge",
        start,
        size: absolute - start,
        hint,
        next,
      };
    }
    const message = this.#message;
    this.#message = null;
    if (!message) return null;
    return finishedMessage(message, next);
  }

  #closeAtEnd(end: number): MboxItem | null {
    const next: MboxPosition = { offset: end, skipping: null };
    if (this.#inPreamble) return { kind: "notMbox" };
    if (this.#skipping) {
      const { start, hint } = this.#skipping;
      this.#skipping = null;
      return {
        kind: "unreadable",
        reason: "tooLarge",
        start,
        size: end - start,
        hint,
        next,
      };
    }
    const message = this.#message;
    this.#message = null;
    if (!message) return null;
    const bytes = joinRuns(message.runs, message.bytes);
    if (bytes[bytes.length - 1] !== NEWLINE || !hasHeaderEnd(bytes)) {
      return {
        kind: "unreadable",
        reason: "truncated",
        start: message.start,
        size: end - message.start,
        hint: describe(bytes.subarray(0, HINT_SOURCE_BYTES)),
        next,
      };
    }
    return finishedMessage({ ...message, runs: [bytes] }, next);
  }
}

function joinRuns(runs: Uint8Array[], limit: number): Uint8Array {
  const total = runs.reduce((sum, run) => sum + run.length, 0);
  const joined = new Uint8Array(Math.min(total, limit));
  let written = 0;
  for (const run of runs) {
    if (written === joined.length) break;
    const piece = run.subarray(0, joined.length - written);
    joined.set(piece, written);
    written += piece.length;
  }
  return joined;
}

function closingBlankLineBytes(runs: Uint8Array[]): number {
  const tail: number[] = [];
  for (let run = runs.length - 1; run >= 0 && tail.length < 4; run -= 1) {
    const bytes = runs[run]!;
    for (let at = bytes.length - 1; at >= 0 && tail.length < 4; at -= 1) {
      tail.unshift(bytes[at]!);
    }
  }
  if (tail.at(-1) !== NEWLINE) return 0;
  const lineBytes = tail.at(-2) === CARRIAGE_RETURN ? 2 : 1;
  return tail.at(-1 - lineBytes) === NEWLINE ? lineBytes : 0;
}

// Sized exactly, so the largest message is copied once and never twice.
function finishedMessage(message: Building, next: MboxPosition): MboxItem {
  const bytes = joinRuns(
    message.runs,
    message.bytes - closingBlankLineBytes(message.runs),
  );
  return {
    kind: "message",
    raw: bytes.buffer as ArrayBuffer,
    fallbackDate: message.fallbackDate,
    start: message.start,
    next,
  };
}

// Knows nothing about jobs or batches: a caller stops by leaving the loop, and
// starts again from any `next` it was given.
export async function* readMbox(
  read: RangeReader,
  size: number,
  from: MboxPosition,
  limit: number = MAX_MESSAGE_BYTES,
): AsyncGenerator<MboxItem, void, void> {
  const splitter = new MboxSplitter(from, limit);
  let offset = from.offset;
  while (offset < size) {
    const length = Math.min(READ_BYTES, size - offset);
    const chunk = await read(offset, length);
    offset += length;
    for (const item of splitter.push(chunk, offset >= size)) {
      yield item;
      if (item.kind === "notMbox") return;
    }
  }
}
