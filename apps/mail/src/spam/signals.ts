import { htmlToSearchText } from "../parse";
import type { Address, AuthResults } from "../types";
import type { MisleadingLink } from "./types";

const MAX_HTML_SCANNED = 256 * 1024;
const MAX_TAG_LENGTH = 4096;
const MAX_LINK_TEXT_LENGTH = 1024;
const MAX_SHOWN_IN_REASON = 80;

export const domainOf = (address: string): string =>
  address.slice(address.lastIndexOf("@") + 1).toLowerCase();

const SECOND_LEVEL = /^(?:ac|co|com|edu|gov|net|org)$/;

// The part of a domain one organisation owns, close enough to tell mail.example.com
// from example.org without shipping a public suffix list. It treats two sites on one
// shared host as the same site, which only ever misses a signal.
export function siteOf(domain: string): string {
  const labels = domain.toLowerCase().split(".");
  const keep =
    labels.length > 2 &&
    labels.at(-1)!.length === 2 &&
    SECOND_LEVEL.test(labels.at(-2)!)
      ? 3
      : 2;
  return labels.slice(-keep).join(".");
}

// The domain this message proves it came from, or null. A pass only counts for the
// From line's own domain: `dkim=pass` for a domain the sender owns says nothing about
// the domain they typed into From. A signature by a parent domain covers its
// subdomains, and DMARC already allows for a signature by a child. DMARC failing beats
// a passing signature, because then the two disagree. Mail stored before the domains
// were kept proves nothing.
export function provedDomain(
  auth: AuthResults | null,
  from: Address | null,
): string | null {
  if (!auth || !from || auth.dmarc === "fail") return null;
  const domain = domainOf(from.address);
  if (auth.dmarc === "pass" && auth.dmarcDomain === domain) return domain;
  const signed = auth.dkimPassDomains?.some(
    (signer) => domain === signer || domain.endsWith(`.${signer}`),
  );
  return signed ? domain : null;
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

const HREF = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

// A link whose text is itself a web address, going somewhere else. "Click here" says
// nothing about where it goes, so it can't mislead this way. One forward pass over a
// bounded prefix, so hostile markup can't make this slow. A link past the prefix goes
// unseen.
export function findMisleadingLink(html: string | null): MisleadingLink | null {
  if (!html) return null;
  const source = html.slice(0, MAX_HTML_SCANNED);
  const lower = source.toLowerCase();
  let position = 0;
  while (position < source.length) {
    const open = lower.indexOf("<a", position);
    if (open === -1) return null;
    if (!/\s/.test(source[open + 2] ?? "")) {
      position = open + 2;
      continue;
    }
    const close = lower.indexOf(">", open);
    if (close === -1) return null;
    const end = lower.indexOf("</a", close);
    if (end === -1) return null;
    position = end + 3;

    const tag = HREF.exec(source.slice(open, open + MAX_TAG_LENGTH));
    const actual = hostOf(tag?.[1] ?? tag?.[2] ?? tag?.[3] ?? "");
    if (!actual) continue;
    const text = source.slice(
      close + 1,
      Math.min(end, close + 1 + MAX_LINK_TEXT_LENGTH),
    );
    const shown = siteShownBy(htmlToSearchText(text));
    if (shown && siteOf(shown) !== siteOf(actual)) {
      return {
        shown: shown.slice(0, MAX_SHOWN_IN_REASON),
        actual: actual.slice(0, MAX_SHOWN_IN_REASON),
      };
    }
  }
  return null;
}
