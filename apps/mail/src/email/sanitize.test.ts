import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { referencedContentIds, sanitizeEmailHtml } from "./sanitize";

const NO_IMAGES = new Map<string, string>();
const DOMAIN = "suite.example.com";
const clean = (html: string, images = NO_IMAGES) =>
  sanitizeEmailHtml(html, images, DOMAIN);
const fixtureText = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures", name), "utf8");
const fixture = fixtureText("hostile-everything.txt");

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
    `<style>a { background: url('https://x.example/a.png') }</style>`,
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

test("no load in the hostile fixture can reach this deployment", async () => {
  const { html, hasRemoteImages } = await clean(
    fixtureText("hostile-loads.txt")
      .replaceAll("__DOMAIN_UPPER__", DOMAIN.toUpperCase())
      .replaceAll("__DOMAIN__", DOMAIN),
  );
  // Text the browser cannot load from, such as `rl(…)` once its escape is gone, may stay.
  expect(html).not.toMatch(
    /(?:\burl\(|image-set\(|src=|background=)[^)>]*cred-/i,
  );
  expect(html).not.toMatch(/srcset|@import|<!--/i);
  expect(hasRemoteImages).toBe(true);
  expect(html).toContain("http://canary.localhost:9911/ref-img.png");
});

test("images and backgrounds on this deployment's own hosts are dropped", async () => {
  for (const url of [
    "https://mail.suite.example.com/a.png",
    "https://AUTH.SUITE.EXAMPLE.COM/a.png",
    "https://suite.example.com/a.png",
    "https://any.other.suite.example.com:8443/a.png",
    "https://mail.suite.example.com./a.png",
    "https://me:pw@mail.suite.example.com/a.png",
    "https://mail%2Esuite.example.com/a.png",
    "https:\\\\mail.suite.example.com\\a.png",
    "https://mail&#46;suite.example.com/a.png",
    "https://mail&#x2e;suite.example.com/a.png",
    "//mail.suite.example.com/a.png",
    "/relative.png",
    "relative.png",
    "?query",
    "ht&#x74;ps://mail.suite.example.com/a.png",
  ]) {
    const image = await clean(`<img src="${url}" alt="a">`);
    expect(image.html).toBe(`<img alt="a">`);
    expect(image.hasRemoteImages).toBe(false);

    const table = await clean(`<table background="${url}"></table>`);
    expect(table.html).toBe("<table></table>");
    expect(table.hasRemoteImages).toBe(false);
  }
});

test("a look-alike of this deployment's domain is someone else's server", async () => {
  for (const url of [
    "https://notsuite.example.com/a.png",
    "https://mail.suite.example.com.evil.example/a.png",
    "https://evil.example/mail.suite.example.com/a.png",
  ]) {
    const { html, hasRemoteImages } = await clean(`<img src="${url}">`);
    expect(html).toContain(url);
    expect(hasRemoteImages).toBe(true);
  }
});

test("a URL reaches the browser in the form that was checked", async () => {
  const relativeToPage = await clean(`<img src="https:cred.png">`);
  expect(relativeToPage.html).toContain(`src="https://cred.png/"`);

  const query = await clean(`<img src="https://x.example/a?b=1&amp;c=2">`);
  expect(query.html).toContain(`src="https://x.example/a?b=1&amp;c=2"`);

  // Decoded once here, and once more by the browser if it were not encoded again.
  const twice = await clean(
    `<div style="background:url&#38;lpar;//mail.suite.example.com/a&#38;rpar;">a</div>`,
  );
  expect(twice.html).toContain("&amp;lpar;");
});

test("CSS on this deployment's hosts or relative to the page loads nothing", async () => {
  for (const css of [
    "url(https://mail.suite.example.com/a.png)",
    "URL('//auth.suite.example.com/a.png')",
    `url( "https://mail.suite.example.com./a.png" )`,
    "url(/a.png)",
    "url(a.png)",
    "url()",
    "url(cid:logo)",
    `image-set("https://mail.suite.example.com/a.png" 1x)`,
    `image-set("a.png" 1x, "https://x.example/b.png" 2x)`,
    `-webkit-image-set(url(/a.png) 1x)`,
    `image-set(url(https:a.png) 1x, url(a.png) 2x)`,
  ]) {
    const { html } = await clean(`<style>p{background:${css}}</style>`);
    expect(html).toBe("<style>p{background:none}</style>");
    const attribute = await clean(
      `<p style="background:${css.replaceAll('"', "&quot;")}">a</p>`,
    );
    expect(attribute.html).toBe(`<p style="background:none">a</p>`);
  }
});

test("a quote in a data URL cannot end it early and start another load", async () => {
  const { html } = await clean(
    `<style>p{background:url('data:image/png,"),url(//mail.suite.example.com/a)')}</style>`,
  );
  expect(html).toBe(
    `<style>p{background:url("data:image/png,%22),url(//mail.suite.example.com/a)")}</style>`,
  );
});

test("CSS that loads from elsewhere counts as a remote image", async () => {
  for (const css of [
    `@import "https://x.example/a.css";`,
    "@IMPORT url(https://x.example/a.css) screen;",
    `p{background:image-set("https://x.example/a.png" 1x)}`,
    `p{background:-webkit-image-set(url(https://x.example/a.png) 1x)}`,
    `p{background:image-set(type("image/png") "https://x.example/a.png")}`,
    "p{background:\\75 rl(https://x.example/a.png)}",
    "p{background:u\\72l(https://x.example/a.png)}",
    "p{background:\\000075rl(https://x.example/a.png)}",
    "p{background:\\u\\r\\l(https://x.example/a.png)}",
    "@\\69mport 'https://x.example/a.css';",
    "p{background:image-s\\65t('https://x.example/a.png' 1x)}",
  ]) {
    const { hasRemoteImages } = await clean(`<style>${css}</style>`);
    expect(hasRemoteImages).toBe(true);
  }
  const { html, hasRemoteImages } = await clean(
    `<style>p{background:image-set("https://x.example/a.png" 1x)}</style>`,
  );
  expect(hasRemoteImages).toBe(true);
  expect(html).toContain(`image-set("https://x.example/a.png" 1x)`);
});

test("imports and escapes that hide a URL are stripped", async () => {
  for (const css of [
    `@import "https://x.example/a.css";`,
    `@im/**/port "https://x.example/a.css";`,
    "@\\69mport 'https://x.example/a.css';",
  ]) {
    const { html } = await clean(`<style>${css}</style>`);
    expect(html.toLowerCase()).not.toMatch(/@import|\\/);
  }
  for (const css of [
    "\\75 rl(https://x.example/a.png)",
    "u\\72l(https://x.example/a.png)",
    "url(https://x.example/\\61.png)",
    `url("https://mail\\3002 suite.example.com/a")`,
    `image-set("https://mail\\3002 suite.example.com/a" 1x)`,
  ]) {
    const { html } = await clean(`<style>p{background:${css}}</style>`);
    expect(html).not.toContain("url(https://x.example/\\");
    expect(html).not.toMatch(/\burl\(https:\/\/x\.example\/a\.png/);
    expect(html).not.toMatch(/(?:\burl|image-set)\([^)]*mail/);
  }
});

test("an escape or comment cannot rebuild what was removed", async () => {
  const split = await clean(
    `<style>p{background:ur\\41 l(/cred.png);background:url/**/(/cred.png)}</style>`,
  );
  expect(split.html).not.toMatch(/url\(\s*\/cred/);

  const breakout = await clean(
    `<style></style\\0 ><img src=x onerror=alert(1)></style>`,
  );
  expect(breakout.html.toLowerCase()).not.toMatch(/<\/style\s*>\s*<img/);
  expect(breakout.html).toEndWith("</style>");
});

test("harmless CSS survives cleaning", async () => {
  const { html, hasRemoteImages } = await clean(
    `<style>a:hover{color:red}li:before{content:"\\2022"}</style><p style="font-family:&quot;Segoe UI&quot;;background:url(data:image/png;base64,AAAA)">a</p>`,
  );
  expect(hasRemoteImages).toBe(false);
  expect(html).toContain(`a:hover{color:red}`);
  expect(html).toContain(`content:"\\2022"`);
  expect(html).toContain(`font-family:&quot;Segoe UI&quot;`);
  expect(html).toContain(`url(&quot;data:image/png;base64,AAAA&quot;)`);
});

test("a block of CSS split across chunks is still cleaned as one", async () => {
  const padding = "a{color:red}".repeat(20_000);
  const { html, hasRemoteImages } = await clean(
    `<style>${padding}p{background:url(/cred.png);background:url(https://x.example/a.png)}</style><p>after</p>`,
  );
  expect(html).not.toContain("cred.png");
  expect(html).toContain("<p>after</p>");
  expect(hasRemoteImages).toBe(true);
});

test("CSS built to make the cleaner slow finishes quickly", async () => {
  const size = 1_900_000;
  for (const piece of [
    " ",
    "url(",
    "url( ",
    `url("`,
    `url('`,
    "image-set(",
    `image-set("a",`,
    `"a"`,
    "@import ",
    "\\",
    "/*",
    "</",
  ]) {
    const css = piece.repeat(Math.ceil(size / piece.length));
    const started = performance.now();
    await clean(`<style>url(${css}</style>`);
    await clean(`<p style='url(${css.replaceAll("'", "")}'>a</p>`);
    expect(performance.now() - started).toBeLessThan(2_000);
  }
}, 60_000);

test("a 2 MB tag made of attributes is cleaned in linear time", async () => {
  const attributes = Array.from({ length: 210_000 }, (_, i) => `a${i}=1`);
  const tag = `<p ${attributes.join(" ")}>Hidden</p>`;
  expect(tag.length).toBeGreaterThan(1_900_000);
  const started = performance.now();
  const { html } = await clean(`<p>Kept</p>${tag}<p>After</p>`);
  // Removing the attributes one by one took many seconds. Cleaning takes well under one.
  expect(performance.now() - started).toBeLessThan(500);
  expect(html).toBe("<p>Kept</p><p>After</p>");
}, 30_000);

test("an ordinary tag keeps its safe attributes however many it has", async () => {
  const { html } = await clean(
    `<td align="left" bgcolor="white" data-a="1">a</td>`,
  );
  expect(html).toBe(`<td align="left" bgcolor="white">a</td>`);
});

test("a tag the mail never finishes is removed", async () => {
  for (const unfinished of [
    `<img src=x onerror=alert(1)//`,
    `<img src="https://x.example/a.png" onerror="alert(1)"`,
    `<img alt=">" src=x onerror=alert(1)`,
    `<img alt='>' onerror="alert(1)`,
    `<meta http-equiv=refresh content="0;url=https://x.example/`,
    `<iframe src="https://x.example/`,
    `<iframe src=https://x.example/ `,
    `<a href="https://x.example/`,
    `<a b="c`,
    `</p`,
    `<!-- a comment that does not end <img src=x>`,
    `<!doctype`,
    `<?php`,
    `<script src=https://x.example/a.js`,
  ]) {
    const { html } = await clean(`<p>Kept</p>${unfinished}`);
    expect(html).toBe("<p>Kept</p>");
  }
});

test("finished tags and ordinary text are not mistaken for unfinished ones", async () => {
  for (const html of [
    `<p>1 < 2 and 3 > 2</p>`,
    `<p title="a>b">c</p>`,
    `<p>ends with a less-than <`,
    `<p>ends with text`,
    `<style>p<q{}</style><p>after</p>`,
    `<style>p{content:"unclosed}`,
    `<xmp><a b="</xmp><p>after</p>`,
  ]) {
    const result = await clean(html);
    expect(result.html.length).toBeGreaterThan(0);
    if (html.includes("after")) expect(result.html).toContain("<p>after</p>");
  }
  expect((await clean(`<p x"y>c</p>`)).html).toBe("<p>c</p>");
  expect((await clean(`<p>1 < 2</p>`)).html).toBe("<p>1 < 2</p>");
});
