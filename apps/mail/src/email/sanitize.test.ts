import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { referencedContentIds, sanitizeEmailHtml } from "./sanitize";

const NO_IMAGES = new Map<string, string>();
const clean = (html: string, images = NO_IMAGES) =>
  sanitizeEmailHtml(html, images);
const fixture = readFileSync(
  join(import.meta.dir, "../../fixtures/hostile-everything.txt"),
  "utf8",
);

test("the hostile fixture loses every way to run code or leave the frame", async () => {
  const { html } = await clean(fixture);
  for (const gone of [
    "<script",
    "<iframe",
    "<object",
    "<embed",
    "<svg",
    "<video",
    "<audio",
    "<meta",
    "<base",
    "<link",
    "<form",
    "<input",
    "<button",
    "onerror",
    "onload",
    "onfocus",
    "javascript:",
    "srcset=",
    "ping=",
    "_self",
    "_top",
    "data:text/html",
    "comment.png",
  ]) {
    expect(html.toLowerCase()).not.toContain(gone);
  }
  expect(html).toContain("Hostile everything");
});

test("links open in a new tab, and only ordinary schemes stay links", async () => {
  const { html } = await clean(
    `<a href="HTTPS://Example.com/x" target="_self">a</a><a href="mailto:a@b.org">b</a><a href=" java\tscript:alert(1)">c</a><a href="/relative">d</a>`,
  );
  expect(html).toContain(
    `<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">a</a>`,
  );
  expect(html).toContain(
    `<a href="mailto:a@b.org" target="_blank" rel="noopener noreferrer">b</a>`,
  );
  expect(html).toContain("<a>c</a>");
  expect(html).toContain("<a>d</a>");
});

test("remote images are reported and sent with no referrer", async () => {
  const withImage = await clean(`<img src="https://x.example/a.png" alt="a">`);
  expect(withImage.hasRemoteImages).toBe(true);
  expect(withImage.html).toContain(`referrerpolicy="no-referrer"`);

  for (const html of [
    `<div style="background:url(https://x.example/a.png)">a</div>`,
    `<style>a { background: url('//x.example/a.png') }</style>`,
    `<table background="https://x.example/a.png"></table>`,
  ]) {
    expect((await clean(html)).hasRemoteImages).toBe(true);
  }
  expect((await clean("<p>Just words.</p>")).hasRemoteImages).toBe(false);
});

test("an inline image is embedded only if the server supplied it", async () => {
  const dataUri = "data:image/png;base64,AAAA";
  const images = new Map([["logo@x", dataUri]]);
  const { html, embeddedContentIds, hasRemoteImages } = await clean(
    `<img src="cid:logo%40x"><img src="cid:missing@x" alt="gone">`,
    images,
  );
  expect(html).toContain(`<img src="${dataUri}">`);
  expect(html).not.toContain("cid:");
  expect(html).toContain(`<img alt="gone">`);
  expect(embeddedContentIds).toEqual(["logo@x"]);
  expect(hasRemoteImages).toBe(false);
  expect(
    await referencedContentIds(`<img src="cid:a@x"><img src="b.png">`),
  ).toEqual(new Set(["a@x"]));
});

test("only pictures survive as data images", async () => {
  const { html } = await clean(
    `<img id="a" src="data:image/png;base64,AAAA"><img id="b" src="data:image/svg+xml,<svg/>"><img id="c" src="data:text/html,x">`,
  );
  expect(html).toContain(`<img id="a" src="data:image/png;base64,AAAA">`);
  expect(html).toContain(`<img id="b">`);
  expect(html).toContain(`<img id="c">`);
});

test("mail that chose its own colours is told apart from plain mail", async () => {
  for (const html of [
    `<p style="color: navy">a</p>`,
    `<table bgcolor="white"></table>`,
    `<font color="red">a</font>`,
    `<style>p { margin: 0 }</style>`,
  ]) {
    expect((await clean(html)).designed).toBe(true);
  }
  for (const html of [
    `<div dir="ltr">Hello</div>`,
    `<p style="margin:0;border-color:gray">a</p>`,
  ]) {
    expect((await clean(html)).designed).toBe(false);
  }
});

test("hostile markup in odd places does not get through", async () => {
  for (const html of [
    `<![CDATA[><img src=x onerror=alert(1)>]]>`,
    `<a href="https://a.example" ONCLICK="x">a</a>`,
    `<details open ontoggle=alert(1)>a</details>`,
    `<body onpageshow=alert(1)>`,
    `<marquee onstart=alert(1)>a</marquee>`,
    `<div contenteditable autofocus onfocus=alert(1) popover>a</div>`,
  ]) {
    const result = (await clean(html)).html.toLowerCase();
    expect(result).not.toMatch(/\son[a-z]+\s*=/);
    expect(result).not.toContain("contenteditable");
  }
});
