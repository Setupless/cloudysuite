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
const REMOTE_URL_IN_CSS = /url\(\s*['"]?\s*(?:https?:)?\/\//i;
const COLOUR_IN_CSS = /(?:^|[;{\s])(?:background(?:-color|-image)?|color)\s*:/i;
const COLOUR_ATTRIBUTES = new Set(["bgcolor", "color", "text", "background"]);

const safeLink = (raw: string): string | null => {
  const url = URL.parse(raw.trim());
  return url && LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
};

const isRemote = (raw: string): boolean => {
  const url = URL.parse(raw.trim());
  return url !== null && REMOTE_PROTOCOLS.has(url.protocol);
};

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
): Promise<SanitizedHtml> {
  let hasRemoteImages = false;
  let designed = false;
  const embedded = new Set<string>();

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(element) {
        for (const [name, value] of [...element.attributes]) {
          if (name === "href" || name === "src") continue;
          if (!SAFE_ATTRIBUTES.has(name) && !name.startsWith("aria-")) {
            element.removeAttribute(name);
            continue;
          }
          if (COLOUR_ATTRIBUTES.has(name)) designed = true;
          if (name === "background") {
            if (isRemote(value)) hasRemoteImages = true;
            else element.removeAttribute(name);
          }
          if (name === "style") {
            if (REMOTE_URL_IN_CSS.test(value)) hasRemoteImages = true;
            if (COLOUR_IN_CSS.test(value)) designed = true;
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
        const src = element.getAttribute("src") ?? "";
        const contentId = contentIdOf(src);
        const inline = contentId ? inlineImages.get(contentId) : undefined;
        if (contentId && inline) {
          embedded.add(contentId);
          element.setAttribute("src", inline);
        } else if (isRemote(src)) {
          hasRemoteImages = true;
          element.setAttribute("src", src.trim());
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
      text(chunk) {
        if (REMOTE_URL_IN_CSS.test(chunk.text)) hasRemoteImages = true;
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
    html: await rewriter.transform(new Response(html)).text(),
    hasRemoteImages,
    designed,
    embeddedContentIds: [...embedded],
  };
}
