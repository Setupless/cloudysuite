import { htmlToSearchText } from "../parse";
import type { Address, AuthResults, NewMessage } from "../types";
import { isSharedEnding, type MisleadingLink, type SpamReason } from "./types";

const MAX_HTML_SCANNED = 256 * 1024;
const MAX_TAG_LENGTH = 4096;
const MAX_LINK_TEXT_LENGTH = 1024;
const MAX_SHOWN_IN_REASON = 80;
const MAX_MISLEADING_LINKS = 8;

export const domainOf = (address: string): string =>
  address.slice(address.lastIndexOf("@") + 1).toLowerCase();

// The part of a domain one organisation owns, close enough to tell mail.example.com
// from example.org without shipping a public suffix list. It treats two sites on one
// shared host as the same site, which only ever misses a signal.
export function siteOf(domain: string): string {
  const labels = domain.toLowerCase().split(".");
  return labels
    .slice(labels.length > 2 && isSharedEnding(labels) ? -3 : -2)
    .join(".");
}

// The domain this message proves it came from, or null. A DMARC pass means aligned with
// the From line by definition, so it counts when the header doesn't name the domain,
// and not when it names another. A DKIM pass counts only for a named domain that is
// the From line's or a parent of it: `dkim=pass` for a domain the sender owns says
// nothing about the domain they typed into From. DMARC failing beats a passing
// signature, because then the two disagree.
export function provedDomain(
  auth: AuthResults | null,
  from: Address | null,
): string | null {
  if (!auth || !from || auth.dmarc === "fail") return null;
  const domain = domainOf(from.address);
  if (auth.dmarc === "pass" && (auth.dmarcDomain ?? domain) === domain) {
    return domain;
  }
  const signed = auth.dkimPassDomains?.some(
    (signer) => domain === signer || domain.endsWith(`.${signer}`),
  );
  return signed ? domain : null;
}

export const dmarcEnforced = (auth: AuthResults | null): boolean =>
  auth?.dmarc === "fail" &&
  (auth.dmarcPolicy === "quarantine" || auth.dmarcPolicy === "reject");

const failedACheck = (auth: AuthResults | null): boolean =>
  auth !== null &&
  (auth.spf === "fail" ||
    auth.spf === "softfail" ||
    auth.dkim === "fail" ||
    auth.dmarc === "fail");

const siteLink = ({ shown, actual }: MisleadingLink): MisleadingLink => ({
  shown: siteOf(shown),
  actual: siteOf(actual),
});

const nameAsLink = (shown: string, address: string): MisleadingLink => ({
  shown: domainOf(shown),
  actual: domainOf(address),
});

export function isAccepted(
  link: MisleadingLink,
  accepted: readonly MisleadingLink[],
): boolean {
  const { shown, actual } = siteLink(link);
  return accepted.some((one) => one.shown === shown && one.actual === actual);
}

// How much a message that can't prove its sender looks forged, once a person has said
// they trust that sender. "strong" sends it to Spam. "weak" means a link alone with no
// failed check: click tracking does that too, so the message is scored instead of
// skipping the filter. Anything else can't be told apart from real mail that has lost
// its signature on the way, and real mail in Spam is the worse mistake. A link or name
// in `accepted` was on mail a person already took out of Spam, so it is no evidence.
export function forgeryEvidence(
  message: Pick<
    NewMessage,
    "authResults" | "from" | "attachments" | "spamFacts"
  >,
  accepted: readonly MisleadingLink[],
): "strong" | "weak" | null {
  const { authResults: auth, from, attachments, spamFacts } = message;
  if (dmarcEnforced(auth) || spamFacts?.ambiguousFrom) return "strong";
  const link = spamFacts?.misleadingLinks.some(
    (one) => !isAccepted(one, accepted),
  );
  if (failedACheck(auth)) {
    const shown = from && addressShownInName(from);
    const lookalike =
      from && shown && !isAccepted(nameAsLink(shown, from.address), accepted);
    if (link || lookalike || runnableFilename(attachments)) return "strong";
  }
  return link ? "weak" : null;
}

// What a message's links and name pointed at, from why it was filed, as sites. A tracking
// host is shared by unrelated senders, and a forged From line is easy, so what the link
// says counts as well as where it goes. Otherwise one rescued newsletter would excuse any
// text on that host.
export function acceptedLinksIn(
  reasons: readonly SpamReason[],
  address: string,
): MisleadingLink[] {
  return reasons.flatMap((reason) => {
    if (reason.kind === "linkShowsOtherSite") {
      return [reason, ...(reason.others ?? [])].map(siteLink);
    }
    if (reason.kind === "nameShowsOtherAddress") {
      return [siteLink(nameAsLink(reason.shown, address))];
    }
    return [];
  });
}

const LIST_ID = /(?:^|<)([a-z0-9][a-z0-9._-]*\.[a-z0-9-]{2,})>?\s*$/i;
const MAX_LIST_ID_READ = 512;

// List-Id is `Name <label.lists.example>`, and a sender can write anything in it.
export function listDomainOf(listId: string | null): string | null {
  if (!listId) return null;
  return (
    LIST_ID.exec(listId.slice(-MAX_LIST_ID_READ))?.[1]?.toLowerCase() ?? null
  );
}

const ADDRESS_IN_NAME = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;

export function addressShownInName(from: Address): string | null {
  const shown = ADDRESS_IN_NAME.exec(from.name)?.[0]?.toLowerCase();
  if (!shown) return null;
  return siteOf(domainOf(shown)) === siteOf(domainOf(from.address))
    ? null
    : shown.slice(0, MAX_SHOWN_IN_REASON);
}

export function replyDomainElsewhere(
  from: Address,
  replyTo: Address[],
): string | null {
  const site = siteOf(domainOf(from.address));
  const other = replyTo.find(
    (person) => siteOf(domainOf(person.address)) !== site,
  );
  return other ? domainOf(other.address).slice(0, MAX_SHOWN_IN_REASON) : null;
}

const MIN_LETTERS_TO_SHOUT = 10;

export function isShouting(subject: string | null): boolean {
  if (!subject) return false;
  const uppercase = subject.match(/\p{Lu}/gu)?.length ?? 0;
  return uppercase >= MIN_LETTERS_TO_SHOUT && !/\p{Ll}/u.test(subject);
}

// Files that run code when opened. Mail services refuse most of them outright. A zip
// is not opened to look inside.
const RUNNABLE =
  /\.(?:app|bat|cmd|com|cpl|dll|exe|hta|jar|js|jse|lnk|msi|msp|pif|ps1|reg|scr|vbe|vbs|wsf|wsh)$/;

export function runnableFilename(
  attachments: readonly { filename: string | null }[],
): string | null {
  const found = attachments.find(({ filename }) =>
    RUNNABLE.test(filename?.toLowerCase().replace(/[.\s]+$/, "") ?? ""),
  );
  return found?.filename?.slice(0, MAX_SHOWN_IN_REASON) ?? null;
}

const LOOKS_LIKE_A_SITE =
  /^(https?:\/\/)?(www\.)?((?:[\p{L}\p{N}-]+\.)+\p{L}{2,})(?:[/:?#]\S*)?$/iu;
// So link text such as "report.pdf" isn't read as a website.
const COMMON_ENDINGS = /\.(?:au|ca|co|com|de|edu|fr|gov|io|net|nz|org|uk)$/;

function siteShownBy(linkText: string): string | null {
  const match = LOOKS_LIKE_A_SITE.exec(linkText.trim());
  if (!match) return null;
  const [, scheme, www, domain] = match;
  const host = domain!.toLowerCase();
  return scheme || www || COMMON_ENDINGS.test(host) ? host : null;
}

function hostOf(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

const HREF = /[\s/]href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/;
const NEXT_ANCHOR = /<a[\s/]/g;
const LINK_TEXT_END = /<\/a|<a[\s/]/;

// Where the start tag at `open` ends, minding quotes as a browser does. Null if it
// never does, or runs into the next anchor first, which also keeps the total work to
// about one pass: only a quote can carry this past that next anchor.
function tagEnd(html: string, open: number): number | null {
  const stop = Math.min(html.length, open + MAX_TAG_LENGTH);
  let quote = "";
  for (let index = open + 2; index < stop; index += 1) {
    const char = html[index]!;
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index;
    else if (char === "<" && /^<a[\s/]/.test(html.slice(index, index + 3))) {
      return null;
    }
  }
  return null;
}

// Links whose text is itself a web address, going somewhere else. "Click here" says
// nothing about where it goes, so it can't mislead this way. A malformed tag is skipped,
// never the end of the search, because a sender could otherwise hide every later link
// behind one. A bounded prefix keeps hostile markup from making this slow, and a link
// past the prefix goes unseen. Links are told apart by site, and it keeps looking past
// the first, because a link a person already accepted could otherwise hide a phish
// behind it. Everything here reads the lowercased text, because
// hostnames don't care and lowercasing can change where an offset falls.
export function findMisleadingLinks(html: string | null): MisleadingLink[] {
  if (!html) return [];
  const found: MisleadingLink[] = [];
  const source = html.slice(0, MAX_HTML_SCANNED).toLowerCase();
  for (const { index: open } of source.matchAll(NEXT_ANCHOR)) {
    const close = tagEnd(source, open);
    if (close === null) continue;
    const tag = HREF.exec(source.slice(open, close + 1));
    const actual = hostOf(tag?.[1] ?? tag?.[2] ?? tag?.[3] ?? "");
    if (!actual) continue;
    const after = source.slice(close + 1, close + 1 + MAX_LINK_TEXT_LENGTH);
    const length = LINK_TEXT_END.exec(after)?.index ?? after.length;
    const shown = siteShownBy(htmlToSearchText(after.slice(0, length)));
    if (shown && siteOf(shown) !== siteOf(actual)) {
      const link = {
        shown: shown.slice(0, MAX_SHOWN_IN_REASON),
        actual: actual.slice(0, MAX_SHOWN_IN_REASON),
      };
      if (isAccepted(link, found.map(siteLink))) continue;
      found.push(link);
      if (found.length === MAX_MISLEADING_LINKS) break;
    }
  }
  return found;
}
