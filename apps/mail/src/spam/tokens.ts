// How much of a message the model reads. A hostile 25 MiB body costs the same as a
// short one, because everything here stops at these limits.
export const SCAN_CHARS = 32 * 1024;
export const MAX_TOKENS_PER_MESSAGE = 300;

const MIN_WORD = 3;
const MAX_WORD = 24;

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;
const HAS_LETTER = /\p{L}/u;
const LINK_HOST = /https?:\/\/([a-z0-9.-]+)/gi;

// Words that say nothing about what a message is. A model with few samples would
// otherwise learn them as spam, because spam uses them too.
const SAY_NOTHING = new Set(
  `about above after again all also and any are because been before being below
  between both but can could did does doing down during each few for from further
  had has have having her here hers him his how into its itself just more most much
  myself nor not now off once only other our ours out over own same she should some
  such than that the their theirs them then there these they this those through too
  under until very was were what when where which while who whom why will with would
  you your yours yourself dear hello please thanks thank regards http https www com`.split(
    /\s+/,
  ),
);

// FNV-1a. A 32-bit number takes less room than the word, and the table it goes in
// keeps no readable text from a message someone later deletes for good.
function hashToken(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export type TokenSource = {
  subject: string | null;
  text: string;
  // Only a sender who proved their domain. Otherwise a forged From would teach the
  // model that a real company's domain is spam.
  provedDomain: string | null;
};

// Distinct tokens, in a stable order, so training and untraining a message touch
// exactly the same rows. A subject word and a body word are different tokens, because
// spam uses a subject differently. The subject comes first, so a long body can't push
// it out.
export function tokensOf({
  subject,
  text,
  provedDomain,
}: TokenSource): number[] {
  const tokens = new Set<number>();
  const add = (token: string) => {
    if (tokens.size < MAX_TOKENS_PER_MESSAGE) tokens.add(hashToken(token));
  };
  if (provedDomain) add(`from:${provedDomain}`);
  const words = (value: string, prefix: string) => {
    for (const [word] of value.toLowerCase().matchAll(WORD)) {
      if (tokens.size >= MAX_TOKENS_PER_MESSAGE) return;
      if (word.length < MIN_WORD || word.length > MAX_WORD) continue;
      if (HAS_LETTER.test(word) && !SAY_NOTHING.has(word)) add(prefix + word);
    }
  };
  words((subject ?? "").slice(0, SCAN_CHARS), "subject:");
  const body = text.slice(0, SCAN_CHARS);
  for (const [, host] of body.matchAll(LINK_HOST)) {
    add(`link:${host!.toLowerCase()}`);
  }
  words(body, "");
  return [...tokens];
}
