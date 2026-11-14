// The pieces of a raw message that an app's own emails are built from.

export const CRLF = "\r\n";

export type EmailPerson = { address: string; name: string | null };

export const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

// A header carries one line. A title can hold anything, so nothing in it may end one.
export const oneLine = (text: string) =>
  text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();

const isPlainAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

const base64 = (text: string) => new TextEncoder().encode(text).toBase64();

// Encoded words of whole characters, each short enough for its own line.
function encodedWords(text: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const character of text) {
    if (new TextEncoder().encode(chunk + character).byteLength > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${base64(word)}?=`).join(`${CRLF} `);
}

export const headerText = (text: string) => {
  const line = oneLine(text);
  return isPlainAscii(line) && line.length <= 70 ? line : encodedWords(line);
};

export function mailbox(person: EmailPerson): string {
  const name = person.name && oneLine(person.name);
  if (!name) return `<${person.address}>`;
  if (!isPlainAscii(name)) return `${encodedWords(name)} <${person.address}>`;
  return `"${name.replace(/["\\]/g, "\\$&")}" <${person.address}>`;
}

function base64Lines(text: string): string {
  const encoded = base64(text);
  const lines: string[] = [];
  for (let start = 0; start < encoded.length; start += 76) {
    lines.push(encoded.slice(start, start + 76));
  }
  return lines.join(CRLF);
}

export const part = (headers: string[], body: string) =>
  [...headers, "Content-Transfer-Encoding: base64", "", base64Lines(body)].join(
    CRLF,
  );

export const multipart = (subtype: string, boundary: string, parts: string[]) =>
  [
    `Content-Type: multipart/${subtype}; boundary="${boundary}"`,
    "",
    ...parts.flatMap((one) => [`--${boundary}`, one]),
    `--${boundary}--`,
    "",
  ].join(CRLF);

export const domainOf = (address: string) =>
  address.slice(address.lastIndexOf("@") + 1);
