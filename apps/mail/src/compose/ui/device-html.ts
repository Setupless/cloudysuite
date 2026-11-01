import { EDITOR_TAGS, isEditorLink } from "../editor-tags";

const DROPPED_WITH_CONTENT = new Set([
  "embed",
  "iframe",
  "img",
  "math",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "script",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "xmp",
]);

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

// New nodes rather than cleaned markup, because markup that is parsed a second time can
// turn into something the first pass never saw.
function copyAllowed(from: Node, into: Node) {
  for (const child of from.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      into.appendChild(document.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    const tag = element.localName;
    if (element.namespaceURI !== HTML_NAMESPACE) continue;
    if (DROPPED_WITH_CONTENT.has(tag)) continue;
    if (!EDITOR_TAGS.has(tag)) {
      copyAllowed(element, into);
      continue;
    }
    const copy = document.createElement(tag);
    if (tag === "a") {
      const href = element.getAttribute("href");
      if (href !== null && isEditorLink(href)) copy.setAttribute("href", href);
      for (const name of ["target", "rel"]) {
        const value = element.getAttribute(name);
        if (value !== null) copy.setAttribute(name, value);
      }
    }
    copyAllowed(element, copy);
    into.appendChild(copy);
  }
}

// The one way a body reaches the live editor. The server's copy is already clean, and
// IndexedDB can hold anything, so nothing here relies on where the string came from.
// DOMParser's document is inert: its scripts don't run and its images don't load.
export function editorContent(html: string): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const content = document.createDocumentFragment();
  copyAllowed(parsed.body, content);
  return content;
}

const BLOCKS = new Set(["blockquote", "div", "li", "ol", "p", "ul"]);

function appendText(node: Node, lines: string[]) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      lines[lines.length - 1] += child.textContent ?? "";
      continue;
    }
    const tag = (child as Element).localName;
    if (tag === "br") {
      lines.push("");
      continue;
    }
    appendText(child, lines);
    if (BLOCKS.has(tag) && lines.at(-1) !== "") lines.push("");
  }
}

export function plainTextOf(html: string): string {
  const lines = [""];
  appendText(editorContent(html), lines);
  return lines.join("\n").trim();
}

const QUOTE_REMOVED =
  "applet,audio,base,button,embed,form,frame,frameset,iframe,input,link,math,meta,noscript,object,script,select,source,svg,template,textarea,track,video";
const QUOTE_URL_ATTRIBUTES = ["action", "background", "formaction", "poster"];

// A kept quote goes in the same sandboxed frame as all mail, with no script and no
// same-origin. The server's sanitizer never saw a device's copy, and the frame alone
// doesn't stop everything: Firefox has fetched a raw `srcset` despite the frame's CSP.
export function deviceQuoteHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const element of parsed.querySelectorAll(QUOTE_REMOVED)) {
    element.remove();
  }
  for (const element of parsed.querySelectorAll("*")) {
    for (const { name, value } of Array.from(element.attributes)) {
      const unsafe =
        name.startsWith("on") ||
        name === "srcset" ||
        QUOTE_URL_ATTRIBUTES.includes(name) ||
        (name === "src" && !value.trim().toLowerCase().startsWith("data:")) ||
        (name === "href" && !isEditorLink(value));
      if (unsafe) element.removeAttribute(name);
    }
  }
  return parsed.head.innerHTML + parsed.body.innerHTML;
}
