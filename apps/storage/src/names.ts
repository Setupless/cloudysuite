// Names follow one rule everywhere, because WebDAV will later need one path per item.
const MAX_NAME_BYTES = 255;
const MAX_EXTENSION_BYTES = 32;
// Direction marks can show "exe.pdf" for a file that ends in .exe, and invisible ones
// make twins of a name. The joiners U+200C and U+200D stay: Persian and emoji need them.
const FORBIDDEN =
  /[/\\\p{Cc}\p{Zl}\p{Zp}\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;
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

// "Report.pdf" and 2 become "Report (2).pdf". The base gives way if the result would
// be too long, so that a name that was allowed stays allowed.
export function numberedName(name: string, number: number): string {
  const dot = name.lastIndexOf(".");
  const dotted = dot > 0 && dot < name.length - 1 ? name.slice(dot) : "";
  // Something this long isn't really an extension, and it must leave room for the number.
  const hasExtension =
    dotted !== "" && byteLength(dotted) <= MAX_EXTENSION_BYTES;
  const extension = hasExtension ? dotted : "";
  const suffix = ` (${number})${extension}`;
  const characters = [...(hasExtension ? name.slice(0, dot) : name)];
  while (
    characters.length > 1 &&
    byteLength(characters.join("")) + byteLength(suffix) > MAX_NAME_BYTES
  ) {
    characters.pop();
  }
  return `${characters.join("").trimEnd()}${suffix}`;
}
