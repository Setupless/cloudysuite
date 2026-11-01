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
  // The comment directly after `method=verdict`, the one place a server states a
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
      else if (verdictComment === null && JUST_A_VERDICT.test(current.trim())) {
        verdictComment = comment;
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

const POLICY_IN_COMMENT = /(?:^|[\s,;])(?:s?p|policy)\s*=\s*([a-z]+)/gi;

// Servers write this as `dmarc=fail (p=NONE sp=REJECT dis=NONE)` or as the property
// `policy.dmarc=none`. Which of p and sp applied isn't stated, and real mail in Spam
// costs more than a forgery scored on its other signs, so the weakest one stands.
function statedPolicy({ text, verdictComment }: Resinfo): DmarcPolicy | null {
  const stated = [...(verdictComment?.matchAll(POLICY_IN_COMMENT) ?? [])].map(
    (match) => match[1]!.toLowerCase(),
  );
  const property = propertyOf(text, "policy\\.dmarc");
  if (property) stated.push(property);
  return DMARC_POLICIES.find((policy) => stated.includes(policy)) ?? null;
}

// The domain a method's result was for, from a property such as header.d=example.org.
function propertyOf(info: string, name: string): string | null {
  const start = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"?([^\\s";]+)`, "i");
  return start.exec(info)?.[1]?.toLowerCase() ?? null;
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
      const signer = propertyOf(info, "header\\.d");
      if (signer) (results.dkimPassDomains ??= []).push(signer);
    }
    if (results[method] !== null && verdict !== "pass") continue;
    results[method] = verdict;
    if (method === "dmarc") {
      const domain = propertyOf(info, "header\\.from");
      if (domain) results.dmarcDomain = domain;
      else delete results.dmarcDomain;
      const policy = statedPolicy(part);
      if (policy) results.dmarcPolicy = policy;
      else delete results.dmarcPolicy;
    }
  }
  return results;
}
