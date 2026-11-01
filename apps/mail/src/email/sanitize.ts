// A second layer. The frame's sandbox and Content-Security-Policy are what stop
// hostile mail, and they hold if this misses something. This layer keeps the
// mail readable inside that frame: it opens links in a new tab, says whether
// the message has remote images, and leaves nothing for the browser to try.

export type SanitizedHtml = {
  html: string;
  hasRemoteImages: boolean;
  // The sender chose colours, so the message needs the light page they chose them for.
  designed: boolean;
  embeddedContentIds: string[];
};

const REMOVED_WITH_CONTENT = [
  "applet",
  "area",
  "audio",
  "base",
  "bgsound",
  "button",
  "canvas",
  "datalist",
  "embed",
  "frame",
  "frameset",
  "iframe",
  "input",
  "keygen",
  "link",
  "map",
  "math",
  "meta",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "optgroup",
  "option",
  "portal",
  "script",
  "select",
  "source",
  "svg",
  "template",
  "textarea",
  "title",
  "track",
  "video",
];

const REMOVED_KEEPING_CONTENT = ["fieldset", "form", "legend"];

// Removing attributes one by one slows down with every attribute on the tag, so a tag
// built from many of them could use up the Worker's CPU time. No real mail needs this many.
const MAX_ATTRIBUTES_PER_TAG = 200;

const SAFE_ATTRIBUTES = new Set([
  "align",
  "alink",
  "alt",
  "background",
  "bgcolor",
  "border",
  "cellpadding",
  "cellspacing",
  "class",
  "color",
  "cols",
  "colspan",
  "dir",
  "face",
  "frame",
  "height",
  "hspace",
  "id",
  "lang",
  "link",
  "nowrap",
  "role",
  "rows",
  "rowspan",
  "rules",
  "scope",
  "size",
  "span",
  "start",
  "style",
  "summary",
  "text",
  "title",
  "type",
  "valign",
  "value",
  "vlink",
  "vspace",
  "width",
]);

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const REMOTE_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp)[;,]/i;
const COLOUR_IN_CSS = /(?:^|[;{\s])(?:background(?:-color|-image)?|color)\s*:/i;
const COLOUR_ATTRIBUTES = new Set(["bgcolor", "color", "text", "background"]);

const safeLink = (raw: string): string | null => {
  const url = URL.parse(raw.trim());
  return url && LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
};

// The session cookie covers the app domain and every host under it, so a load from
// any of them can carry it. A URL that parses with no base is absolute, and the
// browser gets this normal form, so it cannot read the URL differently from here.
const remoteUrl = (raw: string, ownDomain: string): string | null => {
  const url = URL.parse(raw.trim());
  if (!url || !REMOTE_PROTOCOLS.has(url.protocol)) return null;
  const host = url.hostname.replace(/\.+$/, "");
  const own = ownDomain.toLowerCase();
  // An ampersand in a host is an entity that was not decoded, and no real host has one.
  return host === own || host.endsWith(`.${own}`) || host.includes("&")
    ? null
    : url.href;
};

const ATTRIBUTE_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

// The rewriter returns attributes as written, and the browser decodes them. Any
// other named entity stays literal, because encodeAttribute keeps it from decoding.
const decodeAttribute = (raw: string): string =>
  raw.replace(
    /&(?:#x([\da-f]+);?|#(\d+);?|([a-z]+);)/gi,
    (entity, hex?: string, decimal?: string, name?: string) => {
      if (name) return ATTRIBUTE_ENTITIES[name] ?? entity;
      const point = hex ? Number.parseInt(hex, 16) : Number(decimal);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "�";
    },
  );

// `setAttribute` escapes quotes only. Without this, an encoded `&lpar;` decodes twice.
const encodeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;");

const CSS_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/g;
const CSS_ESCAPE = /\\(?:([\da-f]{1,6})[ \t\r\n\f]?|([\s\S]))/gi;
const CSS_HIDDEN_LOAD = /@import|url\(|image-set\(/i;
const CSS_IMPORT = /@import\b[^;]*;?/gi;
const CSS_QUOTED = `"[^"\\\\\\n\\r\\f]*"|'[^'\\\\\\n\\r\\f]*'`;
const CSS_URL = `url\\(\\s*(?:(?:${CSS_QUOTED})\\s*|[^\\s"'()\\\\]+\\s*)?\\)`;
const CSS_IMAGE_SET_NAME = `(?:-[a-z]+-)?image-set\\(`;
const CSS_IMAGE_SET = `${CSS_IMAGE_SET_NAME}\\s*(?:(?:${CSS_QUOTED}|${CSS_URL})\\s*(?:[\\d.]+[a-z]*\\s*)?(?:,\\s*)?)+\\)`;
// The last two alternatives catch whatever the exact forms did not. Those exact
// forms are spelled so that this code and the browser cannot split them differently.
const CSS_LOAD = new RegExp(
  `${CSS_IMAGE_SET}|${CSS_URL}|${CSS_IMAGE_SET_NAME}|\\b(?:url|src|image)\\(`,
  "gi",
);
const CSS_URL_INSIDE = new RegExp(
  `url\\(\\s*\\)|url\\(\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'()]+))\\s*\\)|"([^"]*)"|'([^']*)'`,
  "gi",
);

const cssEscapeValue = (hex?: string, character?: string): number =>
  hex ? Number.parseInt(hex, 16) : (character as string).charCodeAt(0);

// Rewrites what a browser would load, and works on the text the browser receives,
// so nothing that parses differently here can survive unchecked. An ASCII escape
// has only one use in mail: hiding a name from a filter like this one.
function cleanCss(
  css: string,
  ownDomain: string,
): { css: string; remote: boolean } {
  const withoutComments = css.replace(CSS_COMMENT, " ");
  const decoded = withoutComments.replace(
    CSS_ESCAPE,
    (_, hex?: string, character?: string) =>
      String.fromCodePoint(
        Math.min(cssEscapeValue(hex, character), 0x10ffff) || 0xfffd,
      ),
  );
  let remote = decoded !== withoutComments && CSS_HIDDEN_LOAD.test(decoded);

  const allowed = (url: string, isUrlFunction: boolean): string | null => {
    const absolute = remoteUrl(url, ownDomain);
    if (absolute) {
      remote = true;
      return absolute;
    }
    // The result goes back inside double quotes, which a data URL could close.
    return isUrlFunction && SAFE_DATA_IMAGE.test(url.trim())
      ? url.trim().replaceAll('"', "%22")
      : null;
  };

  const cleaned = withoutComments
    .replace(CSS_ESCAPE, (escape, hex?: string, character?: string) =>
      cssEscapeValue(hex, character) < 0x80 ? "" : escape,
    )
    .replace(CSS_IMPORT, () => {
      remote = true;
      return "";
    })
    .replace(CSS_LOAD, (load) => {
      if (load.endsWith("(")) {
        remote = true;
        return "none(";
      }
      let blocked = false;
      const rewritten = load.replace(
        CSS_URL_INSIDE,
        (
          _,
          urlDouble?: string,
          urlSingle?: string,
          urlBare?: string,
          double?: string,
          single?: string,
        ) => {
          const inUrl = urlDouble ?? urlSingle ?? urlBare;
          const url = allowed(
            inUrl ?? double ?? single ?? "",
            inUrl !== undefined,
          );
          if (!url) blocked = true;
          return inUrl === undefined ? `"${url}"` : `url("${url}")`;
        },
      );
      return blocked ? "none" : rewritten;
    })
    // Removing an escape or a comment can complete a closing `</style>`.
    .replaceAll("</", " ");
  return { css: cleaned, remote };
}

const HTML_SPACE = /[ \t\n\f\r]/;

// Where the markup starting at `start` ends, or -1 if the input ends first. It follows
// the HTML tokenizer's states, because `<a b"c>` closes at `>` while `<a b="c>` doesn't.
function endOfMarkup(html: string, start: number): number {
  if (html.startsWith("<!--", start)) {
    const close = html.indexOf("-->", start + 4);
    return close === -1 ? -1 : close + 2;
  }
  const afterSlash = html[start + 1] === "/" ? start + 2 : start + 1;
  if (!/[a-z]/i.test(html[afterSlash] ?? "")) return html.indexOf(">", start);

  let state: "tagName" | "gap" | "attribute" | "afterAttribute" | "value" =
    "tagName";
  for (let index = afterSlash; index < html.length; index += 1) {
    const character = html[index] as string;
    const space = HTML_SPACE.test(character);
    if (state === "value") {
      if (space) continue;
      if (character === ">") return index;
      if (character === '"' || character === "'") {
        const close = html.indexOf(character, index + 1);
        if (close === -1) return -1;
        index = close;
      } else {
        while (
          index < html.length &&
          !HTML_SPACE.test(html[index] as string) &&
          html[index] !== ">"
        ) {
          index += 1;
        }
        if (html[index] === ">") return index;
      }
      state = "gap";
      continue;
    }
    if (character === ">") return index;
    if (state === "tagName") {
      if (space || character === "/") state = "gap";
    } else if (state === "gap") {
      if (!space && character !== "/") state = "attribute";
    } else if (state === "attribute") {
      if (character === "=") state = "value";
      else if (character === "/") state = "gap";
      else if (space) state = "afterAttribute";
    } else if (character === "=") {
      state = "value";
    } else if (character === "/") {
      state = "gap";
    } else if (!space) {
      state = "attribute";
    }
  }
  return -1;
}

// The rewriter acts only on a finished tag, and passes through one the mail never
// closes. A browser drops that at the end of its input, unless something follows it.
function withoutUnfinishedTag(html: string): string {
  const open = /<[a-z/!?]/gi;
  for (let found = open.exec(html); found; found = open.exec(html)) {
    const end = endOfMarkup(html, found.index);
    if (end === -1) return html.slice(0, found.index);
    open.lastIndex = end + 1;
    const rawText = /^<(style|xmp)[\s/>]/i.exec(
      html.slice(found.index, found.index + 7),
    );
    if (rawText) {
      const close = new RegExp(`</${rawText[1]}`, "gi");
      close.lastIndex = end + 1;
      const closing = close.exec(html);
      if (!closing) return html;
      open.lastIndex = closing.index;
    }
  }
  return html;
}

const contentIdOf = (src: string): string | null => {
  const trimmed = src.trim();
  if (!/^cid:/i.test(trimmed)) return null;
  try {
    return decodeURIComponent(trimmed.slice(4));
  } catch {
    return trimmed.slice(4);
  }
};

// Which inline images a message uses, so the server reads only those from storage.
export async function referencedContentIds(html: string): Promise<Set<string>> {
  const found = new Set<string>();
  await new HTMLRewriter()
    .on("img", {
      element(element) {
        const id = contentIdOf(element.getAttribute("src") ?? "");
        if (id) found.add(id);
      },
    })
    .transform(new Response(html))
    .text();
  return found;
}

export async function sanitizeEmailHtml(
  html: string,
  inlineImages: ReadonlyMap<string, string>,
  ownDomain: string,
): Promise<SanitizedHtml> {
  let hasRemoteImages = false;
  let designed = false;
  const embedded = new Set<string>();
  let styleText = "";

  const rewriter = new HTMLRewriter()
    .onDocument({
      comments(comment) {
        comment.remove();
      },
    })
    .on("*", {
      element(element) {
        const attributes = [...element.attributes];
        if (attributes.length > MAX_ATTRIBUTES_PER_TAG) {
          element.remove();
          return;
        }
        for (const [name, value] of attributes) {
          if (name === "href" || name === "src") continue;
          if (!SAFE_ATTRIBUTES.has(name) && !name.startsWith("aria-")) {
            element.removeAttribute(name);
            continue;
          }
          if (COLOUR_ATTRIBUTES.has(name)) designed = true;
          if (name === "background") {
            const remote = remoteUrl(decodeAttribute(value), ownDomain);
            if (remote) {
              hasRemoteImages = true;
              element.setAttribute(name, encodeAttribute(remote));
            } else {
              element.removeAttribute(name);
            }
          }
          if (name === "style") {
            const { css, remote } = cleanCss(decodeAttribute(value), ownDomain);
            if (remote) hasRemoteImages = true;
            if (COLOUR_IN_CSS.test(css)) designed = true;
            element.setAttribute(name, encodeAttribute(css));
          }
        }
        const tag = element.tagName.toLowerCase();
        if (tag !== "a") element.removeAttribute("href");
        if (tag !== "img") element.removeAttribute("src");
      },
      comments(comment) {
        comment.remove();
      },
    })
    .on("a", {
      element(element) {
        element.removeAttribute("target");
        const link = safeLink(element.getAttribute("href") ?? "");
        if (!link) {
          element.removeAttribute("href");
          return;
        }
        element.setAttribute("href", link);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      },
    })
    .on("img", {
      element(element) {
        const src = decodeAttribute(element.getAttribute("src") ?? "");
        const contentId = contentIdOf(src);
        const inline = contentId ? inlineImages.get(contentId) : undefined;
        const remote = remoteUrl(src, ownDomain);
        if (contentId && inline) {
          embedded.add(contentId);
          element.setAttribute("src", inline);
        } else if (remote) {
          hasRemoteImages = true;
          element.setAttribute("src", encodeAttribute(remote));
          element.setAttribute("referrerpolicy", "no-referrer");
        } else if (!SAFE_DATA_IMAGE.test(src.trim())) {
          element.removeAttribute("src");
        }
      },
    })
    .on("style", {
      element() {
        designed = true;
      },
      // A chunk can end in the middle of a URL, so the whole block is cleaned at once.
      text(chunk) {
        styleText += chunk.text;
        chunk.remove();
        if (!chunk.lastInTextNode) return;
        const { css, remote } = cleanCss(styleText, ownDomain);
        styleText = "";
        if (remote) hasRemoteImages = true;
        chunk.replace(css, { html: true });
      },
    });

  for (const tag of REMOVED_WITH_CONTENT) {
    rewriter.on(tag, {
      element(element) {
        element.remove();
      },
    });
  }
  for (const tag of REMOVED_KEEPING_CONTENT) {
    rewriter.on(tag, {
      element(element) {
        element.removeAndKeepContent();
      },
    });
  }

  return {
    html: withoutUnfinishedTag(
      await rewriter.transform(new Response(html)).text(),
    ),
    hasRemoteImages,
    designed,
    embeddedContentIds: [...embedded],
  };
}
