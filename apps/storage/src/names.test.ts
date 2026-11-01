import { expect, test } from "bun:test";
import {
  cleanItemName,
  nameKeyOf,
  numberedName,
  parseItemName,
  withoutHiddenCharacters,
} from "./names";

test("a name is trimmed and put in NFC", () => {
  const parsed = parseItemName("  Café notes.txt ");
  expect(parsed).toEqual({
    ok: true,
    name: "Café notes.txt",
    nameKey: "café notes.txt",
  });
});

test.each([
  ["", "empty"],
  ["   ", "only spaces"],
  [".", "a dot"],
  ["..", "two dots"],
  ["a/b", "a slash"],
  ["a\\b", "a backslash"],
  ["a\nb", "a new line"],
  ["a\u0000b", "a null"],
  ["a b", "a line separator"],
  ["x".repeat(256), "too many bytes"],
  ["é".repeat(128), "too many bytes once encoded"],
])("%j is refused in plain words (%s)", (raw) => {
  const parsed = parseItemName(raw);
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.message).not.toContain("byte");
});

test.each(["...", ".hidden", "a.b.c", "x".repeat(255), "é".repeat(127)])(
  "%j is allowed",
  (raw) => {
    expect(parseItemName(raw).ok).toBe(true);
  },
);

test("names that differ only in case or composition are the same name", () => {
  expect(nameKeyOf("Café.TXT")).toBe(nameKeyOf("café.txt"));
});

test("a numbered copy keeps its extension, and only the last one counts", () => {
  expect(numberedName("Report.pdf", 2)).toBe("Report (2).pdf");
  expect(numberedName("archive.tar.gz", 3)).toBe("archive.tar (3).gz");
  expect(numberedName("Notes", 2)).toBe("Notes (2)");
  expect(numberedName(".profile", 2)).toBe(".profile (2)");
  expect(numberedName("trailing.", 2)).toBe("trailing. (2)");
});

test("a numbered copy of the longest name is still a valid name", () => {
  const long = `${"é".repeat(125)}.pdf`;
  const numbered = numberedName(long, 12);
  expect(numbered.endsWith(" (12).pdf")).toBe(true);
  expect(parseItemName(numbered).ok).toBe(true);
});

test.each([
  ["invoice‮fdp.exe", "a direction override"],
  ["Re​port.pdf", "a zero-width space"],
  ["​", "only an invisible character"],
])("%j is refused because it holds %s", (raw) => {
  expect(parseItemName(raw).ok).toBe(false);
});

test("the joiners that Persian and emoji need are allowed", () => {
  expect(parseItemName("می‌خواهم 👩‍💻.txt").ok).toBe(true);
});

test("a numbered name stays within the limit, even with a very long ending", () => {
  const numbered = numberedName(`a.${"x".repeat(253)}`, 2);
  expect(new TextEncoder().encode(numbered).byteLength).toBeLessThanOrEqual(
    255,
  );
  expect(parseItemName(numbered).ok).toBe(true);
});

test.each([
  [null, "Attachment"],
  ["", "Attachment"],
  ["   ", "Attachment"],
  ["..", "Attachment"],
  ["‮", "Attachment"],
  ["../../etc/passwd", ".._.._etc_passwd"],
  ["..\\..\\a.exe", ".._.._a.exe"],
  ["invoice‮fdp.exe", "invoicefdp.exe"],
  ["a\r\nb.pdf", "ab.pdf"],
  ["  Report.pdf ", "Report.pdf"],
])("cleanItemName turns %j into %j", (raw, expected) => {
  expect(cleanItemName(raw)).toBe(expected);
});

test("cleanItemName shortens a long name, keeps its extension, and passes the rule", () => {
  const name = cleanItemName(`${"é".repeat(400)}.pdf`);
  expect(name.endsWith(".pdf")).toBe(true);
  expect(parseItemName(name).ok).toBe(true);
});

test("withoutHiddenCharacters keeps what a person can read, slashes included", () => {
  expect(withoutHiddenCharacters(" A/B‮ Ltd\n")).toBe("A/B Ltd");
});
