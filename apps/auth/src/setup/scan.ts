import type { DnsRecord, WorkerDomain } from "./cloudflare";
import type { ZoneScan } from "./model";

const WEB_RECORDS = new Set(["A", "AAAA", "CNAME"]);
const PARENT_LABELS = ["suite", "apps", "workspace", "cloud", "team"];

export const bare = (name: string) => name.toLowerCase().replace(/\.$/, "");

// Cloudflare's API returns full names, but its "expected records" endpoints use
// `@` for the apex, and may return a name relative to the zone.
export function fullName(name: string, zoneName: string): string {
  const host = bare(name);
  if (host === "@" || host === zoneName) return zoneName;
  return host.endsWith(`.${zoneName}`) ? host : `${host}.${zoneName}`;
}

function isCloudflareMx(content: string): boolean {
  return bare(content).endsWith(".mx.cloudflare.net");
}

export function externalMxHosts(
  records: DnsRecord[],
  zoneName: string,
): string[] {
  return records
    .filter(
      (record) =>
        record.type === "MX" &&
        fullName(record.name, zoneName) === zoneName &&
        !isCloudflareMx(record.content),
    )
    .map((record) => bare(record.content));
}

export function scanZone(
  zoneName: string,
  records: DnsRecord[],
  attached: WorkerDomain[],
  scriptName: string,
  resumedLabel?: string | null,
): ZoneScan {
  // Only a custom domain on this Worker is ours. Any other name is someone's site.
  const isOurs = (domain: WorkerDomain) => domain.service === scriptName;
  const ownHosts = new Set(
    attached.filter(isOurs).map((domain) => bare(domain.hostname)),
  );
  const hostedHosts = [
    ...new Set([
      ...records
        .filter((record) => WEB_RECORDS.has(record.type))
        .map((record) => fullName(record.name, zoneName))
        // Names starting with `_` are verification records, not websites.
        .filter((host) => !host.startsWith("_") && !ownHosts.has(host)),
      ...attached
        .filter((domain) => !isOurs(domain))
        .map((domain) => bare(domain.hostname)),
    ]),
  ].sort();

  const isFree = (label: string) => {
    const parent = `${label}.${zoneName}`;
    return !hostedHosts.some(
      (host) => host === parent || host.endsWith(`.${parent}`),
    );
  };

  return {
    hostedHosts,
    externalMx: externalMxHosts(records, zoneName),
    recommendedLabel:
      hostedHosts.length === 0
        ? null
        : (PARENT_LABELS.find(isFree) ??
          `suite-${crypto.randomUUID().slice(0, 4)}`),
    resumedLabel,
  };
}
