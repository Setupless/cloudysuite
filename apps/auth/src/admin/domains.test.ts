import { beforeEach, expect, test } from "bun:test";
import { readEmailDomains } from "./addresses";
import {
  addEmailDomain,
  checkDomain,
  parseDomainName,
  type ResolveDns,
} from "./domains";
import { createKit, type Kit } from "./test-kit";

const READY: Record<string, string[]> = {
  "MX acme.org": [
    "13 route1.mx.cloudflare.net.",
    "86 route2.mx.cloudflare.net.",
  ],
  "TXT acme.org": ['"v=spf1 include:_spf.mx.cloudflare.net ~all"'],
  "MX cf-bounce.acme.org": ["10 route3.mx.cloudflare.net."],
  "TXT cf-bounce._domainkey.acme.org": ['"v=DKIM1; h=sha256; k=rsa; p=AAA"'],
};

const resolver =
  (records: Record<string, string[]>): ResolveDns =>
  async (name, type) =>
    records[`${type} ${name}`] ?? [];

test("every record present means ready", async () => {
  expect(await checkDomain("acme.org", resolver(READY))).toEqual({
    receiving: "found",
    sending: "found",
  });
});

test("another provider's mail servers don't count as ready", async () => {
  const records = { ...READY, "MX acme.org": ["1 aspmx.l.google.com."] };
  expect(await checkDomain("acme.org", resolver(records))).toEqual({
    receiving: "missing",
    sending: "found",
  });
});

test("a lookalike host doesn't count as Cloudflare's mail server", async () => {
  const records = {
    ...READY,
    "MX acme.org": ["1 route1.mx.cloudflare.net.evil.example."],
  };
  expect((await checkDomain("acme.org", resolver(records))).receiving).toBe(
    "missing",
  );
});

test("a failed lookup is reported as unknown, not as missing", async () => {
  const failing: ResolveDns = async () => null;
  expect(await checkDomain("acme.org", failing)).toEqual({
    receiving: "unknown",
    sending: "unknown",
  });
});

test("an SPF record merged with another provider still counts", async () => {
  const records = {
    ...READY,
    "TXT acme.org": [
      '"v=spf1 include:_spf.google.com " "include:_spf.mx.cloudflare.net ~all"',
    ],
  };
  expect((await checkDomain("acme.org", resolver(records))).receiving).toBe(
    "found",
  );
});

let kit: Kit;
beforeEach(async () => {
  kit = await createKit();
});

test("a domain that's ready is added, and can be used for addresses", async () => {
  const result = await addEmailDomain(
    kit.database,
    "ACME.org",
    resolver(READY),
  );
  expect(result.ok).toBe(true);
  expect(await readEmailDomains(kit.database)).toEqual([
    "example.com",
    "acme.org",
  ]);
});

test("a domain that isn't ready is refused on the server", async () => {
  const result = await addEmailDomain(kit.database, "acme.org", resolver({}));
  expect(result.ok).toBe(false);
  expect(await readEmailDomains(kit.database)).toEqual(["example.com"]);
});

test.each([
  "acme",
  "acme..org",
  "-acme.org",
  "a b.org",
  "https://acme.org",
  "acme.org/x",
  "",
])("%s isn't a domain name", (raw) => {
  expect(parseDomainName(raw)).toBeNull();
});
