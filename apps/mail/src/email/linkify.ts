export type TextSegment =
  { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>*_]+$/;

export function linkify(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let position = 0;
  const pushText = (end: number) => {
    if (end > position) {
      segments.push({ kind: "text", text: text.slice(position, end) });
    }
  };
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const candidate = match[0].replace(TRAILING_PUNCTUATION, "");
    const url = URL.parse(candidate);
    if (!url) continue;
    pushText(match.index);
    segments.push({ kind: "link", text: candidate, href: url.href });
    position = match.index + candidate.length;
  }
  pushText(text.length);
  return segments;
}
