import { drizzle } from "drizzle-orm/d1";
import { domains } from "../../../../src/db/schema";
import { type Outcome, refuse } from "../outcome";

export type DnsCheck = "found" | "missing" | "unknown";

export type DomainChecks = { receiving: DnsCheck; sending: DnsCheck };

// null means the lookup itself failed, which is not the same as no records.
export type ResolveDns = (
  name: string,
  type: "MX" | "TXT",
) => Promise<string[] | null>;

export const resolveOverHttps: ResolveDns = async (name, type) => {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", name);
  url.searchParams.set("type", type);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      Status?: number;
      Answer?: { data?: unknown }[];
    };
    // NOERROR with no answer, or NXDOMAIN, both mean the record isn't there.
    if (body.Status !== 0 && body.Status !== 3) return null;
    return (body.Answer ?? []).flatMap(({ data }) =>
      typeof data === "string" ? [data] : [],
    );
  } catch {
    return null;
  }
};

const DOMAIN =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function parseDomainName(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/\.$/, "");
  return DOMAIN.test(name) ? name : null;
}

const CLOUDFLARE_MX = /(^|\s)route[123]\.mx\.cloudflare\.net\.?$/i;
const unquote = (value: string) => value.replaceAll('"', "");

function verdict(results: (boolean | null)[]): DnsCheck {
  if (results.includes(null)) return "unknown";
  return results.every(Boolean) ? "found" : "missing";
}

export async function checkDomain(
  name: string,
  resolve: ResolveDns,
): Promise<DomainChecks> {
  const hasCloudflareMx = async (host: string) => {
    const records = await resolve(host, "MX");
    return records && records.some((record) => CLOUDFLARE_MX.test(record));
  };
  const hasTxt = async (host: string, pattern: RegExp) => {
    const records = await resolve(host, "TXT");
    return records && records.some((record) => pattern.test(unquote(record)));
  };
  const [rootMx, rootSpf, bounceMx, dkim] = await Promise.all([
    hasCloudflareMx(name),
    hasTxt(name, /include:_spf\.mx\.cloudflare\.net/),
    hasCloudflareMx(`cf-bounce.${name}`),
    hasTxt(`cf-bounce._domainkey.${name}`, /v=DKIM1/i),
  ]);
  return {
    receiving: verdict([rootMx, rootSpf]),
    sending: verdict([bounceMx, dkim]),
  };
}

const INVALID_DOMAIN = "That isn't a valid domain. It looks like example.com.";

export async function addEmailDomain(
  database: D1Database,
  raw: string,
  resolve: ResolveDns,
): Promise<Outcome> {
  const name = parseDomainName(raw);
  if (!name) return refuse(INVALID_DOMAIN);
  // Checked again here, so a stale page can't store a domain that isn't ready.
  const checks = await checkDomain(name, resolve);
  if (checks.receiving !== "found" || checks.sending !== "found") {
    return refuse(
      "We can't see all of this domain's email records yet. Finish the steps, then check again.",
    );
  }
  await drizzle(database)
    .insert(domains)
    .values({ name, isPrimary: false })
    .onConflictDoNothing();
  return { ok: true };
}
