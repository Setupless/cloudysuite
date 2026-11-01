import { expect, test } from "bun:test";
import { parseAuthenticationResults } from "./auth-results";

test("reads each method's result from Cloudflare's header", () => {
  expect(
    parseAuthenticationResults(
      "mx.cloudflare.net; dkim=pass header.d=example.org; spf=softfail (domain; of sender) smtp.mailfrom=a@example.org; dmarc=none header.from=example.org",
    ),
  ).toEqual({ spf: "softfail", dkim: "pass", dmarc: "none" });
});

test("ignores a header from any other server", () => {
  expect(
    parseAuthenticationResults("evil.example; spf=pass; dkim=pass; dmarc=pass"),
  ).toBeNull();
  expect(
    parseAuthenticationResults(
      "mx.cloudflare.net.evil.example; spf=pass; dkim=pass",
    ),
  ).toBeNull();
  expect(
    parseAuthenticationResults("(mx.cloudflare.net) evil.example; spf=pass"),
  ).toBeNull();
});

test("anything but a version number after the server's name is refused", () => {
  for (const header of [
    "mx.cloudflare.net\t.evil.com; spf=pass",
    "mx.cloudflare.net .evil.com; spf=pass",
    "mx.cloudflare.net 1 2; spf=pass",
    "mx.cloudflare.net 1a; spf=pass",
    'mx.cloudflare.net "x"; spf=pass',
    'mx.cloudflare.net"x"; spf=pass',
    '"x"mx.cloudflare.net; spf=pass',
    "mx.cloudflare.net spf=pass",
  ]) {
    expect(parseAuthenticationResults(header)).toBeNull();
  }
  for (const header of [
    "mx.cloudflare.net 1; spf=pass",
    "mx.cloudflare.net\t1 ; spf=pass",
    "mx.cloudflare.net (comment) 1 (comment); spf=pass",
    "MX.Cloudflare.NET; spf=pass",
  ]) {
    expect(parseAuthenticationResults(header)?.spf).toBe("pass");
  }
});

test("a comment or quoted string cannot smuggle in a result", () => {
  expect(
    parseAuthenticationResults(
      'mx.cloudflare.net; spf=fail (a; dmarc=pass; (nested; dkim=pass)) x="; dkim=pass;"; dmarc=fail',
    ),
  ).toEqual({ spf: "fail", dkim: null, dmarc: "fail" });
});

test("one passing DKIM signature is enough", () => {
  expect(
    parseAuthenticationResults(
      "mx.cloudflare.net; dkim=fail header.d=a; dkim=pass header.d=b; dkim=none header.d=c",
    )?.dkim,
  ).toBe("pass");
});

test("no results and unknown results stay empty", () => {
  expect(parseAuthenticationResults("mx.cloudflare.net; none")).toEqual({
    spf: null,
    dkim: null,
    dmarc: null,
  });
  expect(parseAuthenticationResults("mx.cloudflare.net; spf=maybe")?.spf).toBe(
    null,
  );
  expect(parseAuthenticationResults(null)).toBeNull();
  expect(parseAuthenticationResults("")).toBeNull();
});

test("an unclosed comment ends the header rather than hanging", () => {
  expect(
    parseAuthenticationResults(
      `mx.cloudflare.net; spf=pass; (${"(".repeat(100_000)}`,
    ),
  ).toEqual({ spf: "pass", dkim: null, dmarc: null });
});
