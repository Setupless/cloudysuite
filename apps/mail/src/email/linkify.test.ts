import { expect, test } from "bun:test";
import { linkify } from "./linkify";

test("web addresses become links and everything else stays text", () => {
  expect(linkify("See https://example.com/a?b=1, then call.")).toEqual([
    { kind: "text", text: "See " },
    {
      kind: "link",
      text: "https://example.com/a?b=1",
      href: "https://example.com/a?b=1",
    },
    { kind: "text", text: ", then call." },
  ]);
});

test("only http and https can become links", () => {
  for (const text of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "<b>not markup</b>",
  ]) {
    expect(linkify(text)).toEqual([{ kind: "text", text }]);
  }
});

test("punctuation around a link stays outside it", () => {
  expect(linkify("(http://a.example/x).")).toEqual([
    { kind: "text", text: "(" },
    { kind: "link", text: "http://a.example/x", href: "http://a.example/x" },
    { kind: "text", text: ")." },
  ]);
});

test("markup right after a link cannot join the link", () => {
  const [, link] = linkify(`x http://a.example/"><script>alert(1)</script>`);
  expect(link).toEqual({
    kind: "link",
    text: "http://a.example/",
    href: "http://a.example/",
  });
});

test("a closing bracket that the link opened stays in the link", () => {
  expect(linkify("Read https://en.wikipedia.org/wiki/Foo_(bar).")).toEqual([
    { kind: "text", text: "Read " },
    {
      kind: "link",
      text: "https://en.wikipedia.org/wiki/Foo_(bar)",
      href: "https://en.wikipedia.org/wiki/Foo_(bar)",
    },
    { kind: "text", text: "." },
  ]);
  expect(linkify("(see https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
    { kind: "text", text: "(see " },
    {
      kind: "link",
      text: "https://en.wikipedia.org/wiki/Foo_(bar)",
      href: "https://en.wikipedia.org/wiki/Foo_(bar)",
    },
    { kind: "text", text: ")" },
  ]);
});
