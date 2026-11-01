// Names follow one rule everywhere, because WebDAV will later need one path per item.
const MAX_NAME_BYTES = 255;
const FORBIDDEN = /[/\\\p{Cc}\p{Zl}\p{Zp}]/u;
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
  const hasExtension = dot > 0 && dot < name.length - 1;
  const extension = hasExtension ? name.slice(dot) : "";
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
