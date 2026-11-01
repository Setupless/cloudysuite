import { sanitizeEmailHtml } from "../email/sanitize";
import type { Address, MessageBody, MessageDetail } from "../types";
import { EDITOR_TAGS } from "./editor-tags";
import type { ComposeMode } from "./types";

const REMOVED_WITH_CONTENT = ["img", "style", "title"];

// What a person wrote, or what a colleague left in a shared draft, goes back into a
// live editor on this site, which has no frame around it. So after the same sanitizer
// as reading, this keeps only what the formatting bar can make, with no way to load
// anything or attach a style.
export async function cleanEditorHtml(
  html: string,
  ownDomain: string,
): Promise<string> {
  const { html: sanitized } = await sanitizeEmailHtml(
    html,
    new Map(),
    ownDomain,
  );
  const rewriter = new HTMLRewriter().on("*", {
    element(element) {
      const tag = element.tagName.toLowerCase();
      if (!EDITOR_TAGS.has(tag)) {
        element.removeAndKeepContent();
        return;
      }
      // A copy, because removing an attribute changes what a live iterator walks next.
      for (const [name] of Array.from(element.attributes)) {
        if (!(tag === "a" && ["href", "target", "rel"].includes(name))) {
          element.removeAttribute(name);
        }
      }
    },
  });
  for (const tag of REMOVED_WITH_CONTENT) {
    rewriter.on(tag, {
      element(element) {
        element.remove();
      },
    });
  }
  return rewriter.transform(new Response(sanitized)).text();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const decodeEntities = (text: string) =>
  text.replace(
    /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi,
    (match, decimal, hex, name) => {
      if (name) return ENTITIES[name.toLowerCase()] ?? match;
      const code = decimal ? Number(decimal) : Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    },
  );

const BLOCK_TAGS = new Set(["div", "p", "blockquote", "ul", "ol", "li"]);
// A quote goes inside our message, so a full document's outer tags have to come off.
const withoutDocumentTags = (html: string) =>
  html.replace(/<!doctype[^>]*>|<\/?(?:html|head|body)\b[^>]*>/gi, "");

const TAG = /<(\/?)([a-z0-9]+)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

// The plain-text part of what the editor produces, which cleanEditorHtml has reduced
// to a few tags. Lists keep their markers, and a link keeps its address, since a
// plain-text reader has no other way to see where it goes.
export function htmlToPlainText(html: string): string {
  let output = "";
  const lists: { ordered: boolean; next: number }[] = [];
  let openLink: string | null = null;
  let linkText = "";
  let position = 0;

  const addText = (text: string) => {
    if (openLink !== null) linkText += text;
    else output += text;
  };
  const breakLine = () => {
    if (output && !output.endsWith("\n")) output += "\n";
  };
  const closeLink = () => {
    if (openLink === null) return;
    const target = openLink.replace(/^mailto:/i, "");
    const label = linkText.trim();
    output += !target
      ? linkText
      : label && label !== target
        ? `${linkText} (${target})`
        : target;
    openLink = null;
    linkText = "";
  };

  TAG.lastIndex = 0;
  for (let match = TAG.exec(html); match !== null; match = TAG.exec(html)) {
    addText(decodeEntities(html.slice(position, match.index)));
    position = match.index + match[0].length;
    const closing = match[1] === "/";
    const tag = match[2]!.toLowerCase();

    if (tag === "br") {
      addText("\n");
    } else if (tag === "a") {
      closeLink();
      if (!closing) {
        const href = HREF.exec(match[3] ?? "");
        openLink = decodeEntities(href?.[1] ?? href?.[2] ?? "");
      }
    } else if (BLOCK_TAGS.has(tag)) {
      // A link nobody closed must not swallow the paragraphs after it. A link around
      // one block, as newsletters write them, still has no text at this point.
      if (linkText.trim()) closeLink();
      breakLine();
      if (tag === "ul" || tag === "ol") {
        if (closing) lists.pop();
        else lists.push({ ordered: tag === "ol", next: 1 });
      } else if (tag === "li" && !closing) {
        const list = lists.at(-1);
        const marker = list?.ordered ? `${list.next++}. ` : "- ";
        output += `${"  ".repeat(Math.max(0, lists.length - 1))}${marker}`;
      }
    }
  }
  addText(decodeEntities(html.slice(position)));
  closeLink();
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const person = (who: Address | null) =>
  who
    ? who.name.trim()
      ? `${who.name.trim()} <${who.address}>`
      : who.address
    : "Unknown sender";

const people = (list: Address[]) => list.map(person).join(", ");

export type Quote = { html: string; text: string; designed: boolean };

const quotedLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");

// Inline pictures stay out of the quote, because a data URL can run to megabytes and
// most mail apps drop them. Forwarding carries them over as attachments instead.
export async function buildQuote(
  parent: MessageDetail,
  body: MessageBody,
  mode: ComposeMode,
  ownDomain: string,
): Promise<Quote> {
  const sanitized = body.html?.trim()
    ? await sanitizeEmailHtml(body.html, new Map(), ownDomain)
    : null;
  const originalHtml = sanitized
    ? withoutDocumentTags(sanitized.html)
    : `<div style="white-space:pre-wrap">${escapeHtml(body.text ?? "")}</div>`;
  const originalText =
    body.text ??
    htmlToPlainText(originalHtml.replace(/<style[\s\S]*?<\/style>/gi, ""));
  const date = new Date(parent.sentAt ?? parent.receivedAt).toUTCString();

  if (mode === "forward") {
    const lines = [
      `From: ${person(parent.from)}`,
      `Date: ${date}`,
      `Subject: ${parent.subject ?? ""}`,
      `To: ${people(parent.to)}`,
      ...(parent.cc.length ? [`Cc: ${people(parent.cc)}`] : []),
    ];
    return {
      html: `<div>---------- Forwarded message ----------<br>${lines.map(escapeHtml).join("<br>")}</div><br><div>${originalHtml}</div>`,
      text: `---------- Forwarded message ----------\n${lines.join("\n")}\n\n${originalText}`,
      designed: sanitized?.designed ?? false,
    };
  }
  const intro = `On ${date}, ${person(parent.from)} wrote:`;
  return {
    html: `<div>${escapeHtml(intro)}</div><blockquote style="margin:0 0 0 0.8ex;border-left:1px solid;padding-left:1ex">${originalHtml}</blockquote>`,
    text: `${intro}\n${quotedLines(originalText)}`,
    designed: sanitized?.designed ?? false,
  };
}

export function assembleBodies(
  written: { html: string; text: string },
  quote: { html: string; text: string } | null,
): { html: string; text: string } {
  if (!quote) return written;
  return {
    html: `<div>${written.html}</div><br>${quote.html}`,
    text: written.text ? `${written.text}\n\n${quote.text}` : quote.text,
  };
}
