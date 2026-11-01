// What the formatting bar can make. Both places that let a body into a live editor keep
// only these: `cleanEditorHtml` on the server, and `editorContent` for the device's copy.
export const EDITOR_TAGS: ReadonlySet<string> = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "div",
  "em",
  "i",
  "li",
  "ol",
  "p",
  "strong",
  "u",
  "ul",
]);

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export const isEditorLink = (href: string): boolean => {
  const url = URL.parse(href);
  return url !== null && LINK_PROTOCOLS.has(url.protocol);
};
