// Names follow one rule everywhere, because WebDAV will later need one path per item.
const MAX_NAME_BYTES = 255;
const MAX_EXTENSION_BYTES = 32;
// Direction marks can show "exe.pdf" for a file that ends in .exe, and invisible ones
// make twins of a name. The joiners U+200C and U+200D stay: Persian and emoji need them.
const HIDDEN =
  /[\p{Cc}\p{Zl}\p{Zp}\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;
const FORBIDDEN = new RegExp(`[/\\\\]|${HIDDEN.source}`, "u");
const FALLBACK_NAME = "Attachment";
const encoder = new TextEncoder();

const byteLength = (text: string) => encoder.encode(text).byteLength;

export type ParsedName =
  { ok: true; name: string; nameKey: string } | { ok: false; message: string };

export const nameKeyOf = (name: string) => name.normalize("NFC").toLowerCase();

export function parseItemName(raw: string): ParsedName {
  const name = raw.trim().normalize("NFC");
  if (name === "") return { ok: false, message: "Type a name first." };
  if (name === "." || name === "..") {
    return {
      ok: false,
      message: `"${name}" can't be used as a name. Choose another.`,
    };
  }
  if (FORBIDDEN.test(name)) {
    return {
      ok: false,
      message:
        "A name can't include a slash, a backslash, or hidden characters. Choose another.",
    };
  }
  if (byteLength(name) > MAX_NAME_BYTES) {
    return { ok: false, message: "That name is too long. Use a shorter one." };
  }
  return { ok: true, name, nameKey: nameKeyOf(name) };
}

function splitExtension(name: string): [base: string, extension: string] {
  const dot = name.lastIndexOf(".");
  const dotted = dot > 0 && dot < name.length - 1 ? name.slice(dot) : "";
  // Something this long isn't really an extension, and it must leave room for the number.
  return dotted !== "" && byteLength(dotted) <= MAX_EXTENSION_BYTES
    ? [name.slice(0, dot), dotted]
    : [name, ""];
}

// The base gives way, so that the result is allowed and keeps what follows it.
function fitName(base: string, suffix: string): string {
  const characters = [...base];
  while (
    characters.length > 1 &&
    byteLength(characters.join("")) + byteLength(suffix) > MAX_NAME_BYTES
  ) {
    characters.pop();
  }
  return `${characters.join("").trimEnd()}${suffix}`;
}

// "Report.pdf" and 2 become "Report (2).pdf".
export function numberedName(name: string, number: number): string {
  const [base, extension] = splitExtension(name);
  return fitName(base, ` (${number})${extension}`);
}

// Takes out what could disguise text from someone else, such as a sender's name that
// reads backwards. For showing, not for naming.
export const withoutHiddenCharacters = (raw: string) =>
  raw.replace(HIDDEN, "").trim();

// For a name no person chose, such as one written by whoever sent an email. There's
// nobody to ask for another, so what `parseItemName` would refuse is cleaned instead.
export function cleanItemName(raw: string | null): string {
  const cleaned = withoutHiddenCharacters(
    (raw ?? "").replace(/[/\\]/g, "_"),
  ).normalize("NFC");
  const [base, extension] = splitExtension(cleaned);
  const parsed = parseItemName(
    byteLength(cleaned) > MAX_NAME_BYTES ? fitName(base, extension) : cleaned,
  );
  return parsed.ok ? parsed.name : FALLBACK_NAME;
}
