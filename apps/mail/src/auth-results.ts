import { siteOf } from "./spam/signals";
import {
  AUTH_VERDICTS,
  type AuthResults,
  type AuthVerdict,
  DMARC_POLICIES,
  type DmarcPolicy,
} from "./types";

const TRUSTED_AUTHSERV_ID = "mx.cloudflare.net";

const METHODS = ["spf", "dkim", "dmarc"] as const;

// RFC 8601: authserv-id [ CFWS authres-version ]. Anything else before the first
// semicolon means the id is not what its first word claims.
const AUTHSERV = /^(\S+)(?:\s+\d+)?$/;

const JUST_A_VERDICT = /^[a-z0-9_-]+\s*=\s*[a-z0-9_-]+$/i;

type Resinfo = {
  text: string;
  // The comments directly after `method=verdict`, the one place a server states a
  // DMARC policy. Text further along can echo what a sender wrote.
  verdictComment: string | null;
};

// Comments can hold semicolons and nest, and a quoted string can hold either, so
// this walks the value once rather than splitting on a pattern. Comments stay out of
// the text. Quoted strings stay in the text, so they cannot vanish from beside the
// authserv-id or a method and leave it looking clean.
function splitResinfo(value: string): Resinfo[] {
  const parts: Resinfo[] = [];
  let current = "";
  let comment = "";
  let verdictComment: string | null = null;
  let depth = 0;
  let quoted = false;
  const finish = () => {
    parts.push({ text: current.trim(), verdictComment });
    current = "";
    verdictComment = null;
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quoted) {
      current += char;
      if (char === "\\") {
        current += value[index + 1] ?? "";
        index += 1;
      } else if (char === '"') quoted = false;
      continue;
    }
    if (depth > 0) {
      if (char === "\\") index += 1;
      else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      if (depth > 0) comment += char;
      else if (JUST_A_VERDICT.test(current.trim())) {
        verdictComment = `${verdictComment ?? ""} ${comment}`;
      }
      continue;
    }
    if (char === "(") {
      depth = 1;
      comment = "";
    } else if (char === '"') {
      quoted = true;
      current += char;
    } else if (char === ";") finish();
    else current += char;
  }
  finish();
  return parts;
}

const POLICY_IN_COMMENT = /(?:^|[\s,;])(s?p|policy)\s*=\s*([a-z]+)/gi;

// A name=value pair, or a quoted string on its own. Matching quoted strings whole means
// that nothing inside one can read as a property.
const PROPERTY =
  /(?:^|\s)([a-z0-9._-]+)\s*=\s*("[^"\\]*(?:\\.[^"\\]*)*"?|[^\s";]*)|"[^"\\]*(?:\\.[^"\\]*)*"?/gi;

function propertiesOf(info: string, name: string): string[] {
  return [...info.matchAll(PROPERTY)].flatMap((match) => {
    if (match[1]?.toLowerCase() !== name) return [];
    const value = /^"?([^\s";]+)/.exec(match[2]!)?.[1];
    return value ? [value.toLowerCase()] : [];
  });
}

const strongest = (stated: readonly string[]): DmarcPolicy | null =>
  DMARC_POLICIES.findLast((policy) => stated.includes(policy)) ?? null;

// Servers write this as `dmarc=fail (p=NONE sp=REJECT dis=NONE)` or as the property
// `policy.dmarc=none`. If one tag is stated twice the strongest stands, so that an echo
// can't talk a real policy down. `sp` covers subdomains only, so a domain that is itself
// the organisation's follows `p`. Otherwise which of the two applied isn't stated, and
// real mail in Spam costs more than a forgery scored on its other signs, so the weaker
// stands. A rarer shared ending makes a domain look like a subdomain, which only reaches
// that weaker answer.
function statedPolicy(
  { text, verdictComment }: Resinfo,
  domain: string | undefined,
): DmarcPolicy | null {
  const tags = [...(verdictComment?.matchAll(POLICY_IN_COMMENT) ?? [])];
  const valuesWhere = (wanted: (tag: string) => boolean) =>
    tags
      .filter((match) => wanted(match[1]!.toLowerCase()))
      .map((match) => match[2]!.toLowerCase());
  const own = strongest([
    ...valuesWhere((tag) => tag !== "sp"),
    ...propertiesOf(text, "policy.dmarc"),
  ]);
  if (domain !== undefined && siteOf(domain) === domain) return own;
  const subdomains = strongest(valuesWhere((tag) => tag === "sp"));
  return (
    DMARC_POLICIES.find((policy) => policy === own || policy === subdomains) ??
    null
  );
}

function toVerdict(raw: string): AuthVerdict | null {
  const verdict = raw === "hardfail" ? "fail" : raw;
  return AUTH_VERDICTS.find((known) => known === verdict) ?? null;
}

// Pass only the first Authentication-Results header. Cloudflare adds its own at
// the top, and anything below it is the sender's to forge.
export function parseAuthenticationResults(
  firstHeader: string | null | undefined,
): AuthResults | null {
  if (!firstHeader) return null;
  const [authserv, ...resinfo] = splitResinfo(firstHeader);
  const authservId = AUTHSERV.exec(authserv?.text ?? "")?.[1]?.toLowerCase();
  if (authservId !== TRUSTED_AUTHSERV_ID) return null;

  const results: AuthResults = { spf: null, dkim: null, dmarc: null };
  for (const part of resinfo) {
    const info = part.text;
    const match = /^([a-z0-9_-]+)\s*=\s*([a-z0-9_-]+)/i.exec(info);
    if (!match) continue;
    const method = METHODS.find((name) => name === match[1]!.toLowerCase());
    const verdict = toVerdict(match[2]!.toLowerCase());
    if (!method || !verdict) continue;
    // A message can carry several DKIM signatures, and one good one is enough.
    if (method === "dkim" && verdict === "pass") {
      const [signer] = propertiesOf(info, "header.d");
      if (signer) (results.dkimPassDomains ??= []).push(signer);
    }
    if (results[method] !== null && verdict !== "pass") continue;
    results[method] = verdict;
    if (method === "dmarc") {
      const [domain] = propertiesOf(info, "header.from");
      if (domain) results.dmarcDomain = domain;
      else delete results.dmarcDomain;
      const policy = statedPolicy(part, domain);
      if (policy) results.dmarcPolicy = policy;
      else delete results.dmarcPolicy;
    }
  }
  return results;
}
