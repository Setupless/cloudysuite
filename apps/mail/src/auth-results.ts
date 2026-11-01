import { AUTH_VERDICTS, type AuthResults, type AuthVerdict } from "./types";

const TRUSTED_AUTHSERV_ID = "mx.cloudflare.net";

const METHODS = ["spf", "dkim", "dmarc"] as const;

// Comments can hold semicolons and nest, and a quoted string can hold either, so
// this walks the value once rather than splitting on a pattern.
function splitResinfo(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === '"') quoted = false;
      continue;
    }
    if (depth > 0) {
      if (char === "\\") index += 1;
      else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      continue;
    }
    if (char === "(") depth = 1;
    else if (char === '"') quoted = true;
    else if (char === ";") {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  parts.push(current.trim());
  return parts;
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
  const authservId = authserv?.split(/\s+/)[0]?.toLowerCase();
  if (authservId !== TRUSTED_AUTHSERV_ID) return null;

  const results: AuthResults = { spf: null, dkim: null, dmarc: null };
  for (const info of resinfo) {
    const match = /^([a-z0-9_-]+)\s*=\s*([a-z0-9_-]+)/i.exec(info);
    if (!match) continue;
    const method = METHODS.find((name) => name === match[1]!.toLowerCase());
    const verdict = toVerdict(match[2]!.toLowerCase());
    if (!method || !verdict) continue;
    // A message can carry several DKIM signatures, and one good one is enough.
    if (results[method] === null || verdict === "pass") {
      results[method] = verdict;
    }
  }
  return results;
}
