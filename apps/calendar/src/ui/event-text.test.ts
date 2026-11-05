import { expect, test } from "bun:test";
import { withLinks } from "./event-text";

test("only https links in notes and places can be opened", () => {
  expect(
    withLinks(
      "Agenda at https://docs.example.org/a. Old copy http://old.example.org",
    ),
  ).toEqual([
    { kind: "text", text: "Agenda at " },
    {
      kind: "link",
      text: "https://docs.example.org/a",
      href: "https://docs.example.org/a",
    },
    { kind: "text", text: ". Old copy " },
    { kind: "text", text: "http://old.example.org" },
  ]);
  expect(withLinks("javascript:alert(1) and ftp://files.example.org")).toEqual([
    { kind: "text", text: "javascript:alert(1) and ftp://files.example.org" },
  ]);
});
