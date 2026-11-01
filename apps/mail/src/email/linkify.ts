export type TextSegment =
  { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?\]}>*_]/;

function count(text: string, character: string): number {
  let total = 0;
  for (const found of text) if (found === character) total++;
  return total;
}

// A closing bracket belongs to the link when the link opened it, as in a wiki address.
function withoutTrailingPunctuation(candidate: string): string {
  let end = candidate.length;
  let open = count(candidate, "(");
  let close = count(candidate, ")");
  while (end > 0) {
    const last = candidate[end - 1] as string;
    if (last === ")") {
      if (close <= open) break;
      close--;
    } else if (!TRAILING_PUNCTUATION.test(last)) {
      break;
    }
    end--;
  }
  return candidate.slice(0, end);
}

export function linkify(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let position = 0;
  const pushText = (end: number) => {
    if (end > position) {
      segments.push({ kind: "text", text: text.slice(position, end) });
    }
  };
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const candidate = withoutTrailingPunctuation(match[0]);
    const url = URL.parse(candidate);
    if (!url) continue;
    pushText(match.index);
    segments.push({ kind: "link", text: candidate, href: url.href });
    position = match.index + candidate.length;
  }
  pushText(text.length);
  return segments;
}
