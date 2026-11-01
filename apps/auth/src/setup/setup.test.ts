import type { Database } from "bun:sqlite";
import { beforeEach, expect, spyOn, test } from "bun:test";
import { createTestDatabase } from "../../../../src/db/test-database";
import { createAuth } from "../auth";
import { appOrigins } from "../origins";
import { CLOUDFLARE_API, cloudflareApiBase } from "./cloudflare";
import { createFakeCloudflare } from "./fake-cloudflare";
import { createFirstAdmin } from "./first-admin";
import { handleSetupRequest, type SetupDependencies } from "./handler";
import { STEP_IDS, type StepId, type StepResult } from "./model";
import { scanZone } from "./scan";
import { TOKEN_PERMISSIONS, tokenFormUrl } from "./token-link";

const OWNER = "0123456789abcdef0123456789abcdef";
const STRANGER = "fedcba9876543210fedcba9876543210";
const ZONE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VERSION = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER_TOKEN = "owner-token-owner-token-owner-token";
const READ_TOKEN = "read-only-token-read-only-token";
const NO_WORKERS_TOKEN = "no-workers-token-no-workers-token";
const STRANGER_TOKEN = "stranger-token-stranger-token-stranger";
const admin = {
  name: "Ada Admin",
  email: "ada@other.example.net",
  password: "a long enough password",
  mailboxLocalPart: "ada",
};
const choice = { zoneId: ZONE, appLabel: null };
const claim = {
  token: OWNER_TOKEN,
  accountId: OWNER,
  scriptName: "cloudysuite",
};

let sqlite: Database;
let d1: D1Database;
let fake: ReturnType<typeof createFakeCloudflare>;
let deps: SetupDependencies;

beforeEach(() => {
  ({ sqlite, d1 } = createTestDatabase());
  fake = createFakeCloudflare();
  fake.addAccount(OWNER, "Example Org");
  fake.addWorker(OWNER, "older", ["old-version"], "2020-01-01T00:00:00Z");
  fake.addWorker(OWNER, "cloudysuite", [VERSION], "2026-01-01T00:00:00Z");
  fake.addZone(OWNER, ZONE, "example.com");
  fake.addToken(OWNER_TOKEN, OWNER);
  fake.addToken(READ_TOKEN, OWNER, ["workers:read", "zone:read"]);
  fake.addToken(NO_WORKERS_TOKEN, OWNER, ["zone:read", "dns:write"]);
  fake.addAccount(STRANGER, "Stranger");
  fake.addWorker(STRANGER, "theirs", ["their-version"]);
  fake.addZone(
    STRANGER,
    "cccccccccccccccccccccccccccccccc",
    "stranger.example",
  );
  fake.addToken(STRANGER_TOKEN, STRANGER);
  deps = {
    database: d1,
    versionId: VERSION,
    secret: undefined,
    apiBase: "https://fake.test/client/v4",
    fetch: fake.fetch,
  };
});

async function post(body: unknown, overrides: Partial<SetupDependencies> = {}) {
  const response = await handleSetupRequest(
    new Request("https://cloudysuite.someone.workers.dev/setup/api", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { ...deps, ...overrides },
  );
  return { status: response.status, body: (await response.json()) as any };
}

const runStep = async (
  stepId: StepId,
  mode: "check" | "run" = "run",
  overrides = {},
) =>
  (await post({ action: "step", claim, choice, stepId, mode }, overrides)).body
    .result as StepResult;

async function runEverything(overrides: Partial<SetupDependencies> = {}) {
  const results = [];
  for (const stepId of STEP_IDS)
    results.push(await runStep(stepId, "run", overrides));
  return results;
}

const count = (table: string) =>
  (sqlite.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

test("the owner's token finds this Worker by its running version, among others", async () => {
  const { status, body } = await post({ action: "claim", token: OWNER_TOKEN });
  expect(status).toBe(200);
  expect(body.worker).toEqual({
    accountId: OWNER,
    accountName: "Example Org",
    scriptName: "cloudysuite",
  });
  expect(body.zones).toEqual([{ id: ZONE, name: "example.com", active: true }]);
});

test("a stranger's token for their own account cannot claim", async () => {
  const { status, body } = await post({
    action: "claim",
    token: STRANGER_TOKEN,
  });
  expect(status).toBe(403);
  expect(body.error.code).toBe("claim-failed");
  expect(body.error.message).toContain("different Cloudflare account");
});

test("a token that can see no Workers is told which permission it lacks", async () => {
  const { status, body } = await post({
    action: "claim",
    token: NO_WORKERS_TOKEN,
  });
  expect(status).toBe(403);
  expect(body.error.message).not.toContain("different Cloudflare account");
  expect(body.error.guide.action).toContain("Workers Scripts: Edit");
  expect(body.error.guide.action).toContain("account");
  expect(JSON.stringify(body)).not.toContain("cloudysuite");
  expect(JSON.stringify(body)).not.toContain(OWNER);
});

test("a stranger with no Workers of their own gets the same answer, and nothing about this one", async () => {
  fake.state.accounts.get(STRANGER)?.workers.clear();
  const { status, body } = await post({
    action: "claim",
    token: STRANGER_TOKEN,
  });
  expect(status).toBe(403);
  expect(body.error.guide.action).toContain("Workers Scripts: Edit");
  expect(JSON.stringify(body)).not.toContain("cloudysuite");
  expect(JSON.stringify(body)).not.toContain(OWNER);
});

test("a stranger cannot get through by naming their own Worker, or ours", async () => {
  for (const forged of [
    { token: STRANGER_TOKEN, accountId: STRANGER, scriptName: "theirs" },
    { token: STRANGER_TOKEN, accountId: OWNER, scriptName: "cloudysuite" },
  ]) {
    const { status } = await post({
      action: "finish",
      claim: forged,
      choice: { zoneId: "cccccccccccccccccccccccccccccccc", appLabel: null },
      admin,
    });
    expect(status).toBe(403);
  }
  expect(count("user")).toBe(0);
});

test("a read-only token for the right account cannot claim or finish", async () => {
  const claimed = await post({ action: "claim", token: READ_TOKEN });
  expect(claimed.status).toBe(403);
  expect(claimed.body.error.message).toContain("can only read");

  await runEverything({ secret: "already-set" });
  const finished = await post(
    { action: "finish", claim: { ...claim, token: READ_TOKEN }, choice, admin },
    { secret: "already-set" },
  );
  expect(finished.status).toBe(403);
  expect(count("user")).toBe(0);
});

test("a success response without Cloudflare's confirmation proves nothing", async () => {
  const original = fake.fetch;
  deps.fetch = async (url, init) =>
    url.endsWith("/script-settings")
      ? new Response("", { status: 200 })
      : original(url, init);
  const { status } = await post({ action: "claim", token: OWNER_TOKEN });
  expect(status).toBe(502);
  expect(count("user")).toBe(0);
});

test("an unknown running version fails closed", async () => {
  const { status, body } = await post(
    { action: "claim", token: OWNER_TOKEN },
    { versionId: "" },
  );
  expect(status).toBe(403);
  expect(body.error.message).toContain("can't tell which version");
});

test("the walk stops after 50 Workers and says so", async () => {
  fake.addAccount(OWNER, "Example Org");
  for (let i = 0; i < 60; i++) fake.addWorker(OWNER, `worker-${i}`, [`v-${i}`]);
  const { status, body } = await post({ action: "claim", token: OWNER_TOKEN });
  expect(status).toBe(403);
  expect(body.error.message).toContain("too many Workers");
  const lookups = fake.calls.filter((call) => call.path.includes("/versions/"));
  expect(lookups.length).toBe(50);
});

test("the proof still holds after setting the secret changes the running version", async () => {
  expect((await runStep("auth-secret")).state).toBe("needs-action");
  const [newVersion] =
    fake.state.accounts.get(OWNER)?.workers.get("cloudysuite")?.versions ?? [];
  expect(newVersion).not.toBe(VERSION);

  for (const versionId of [VERSION, newVersion as string]) {
    const { status } = await post(
      { action: "step", claim, choice, stepId: "auth-secret", mode: "check" },
      { versionId },
    );
    expect(status).toBe(200);
  }
});

test("every step checks, applies, checks again, and a repeat run writes nothing", async () => {
  const results = await runEverything({ secret: "already-set" });
  expect(results.map((result) => result.state)).toEqual([
    "done",
    "done",
    "done",
    "done",
    "done",
  ]);

  const zone = fake.state.zones.get(ZONE);
  expect(zone?.routing.enabled).toBe(true);
  expect(zone?.catchAll).toEqual({
    enabled: true,
    actions: [{ type: "worker", value: ["cloudysuite"] }],
  });
  expect(zone?.sending.map((row) => row.name)).toEqual(["example.com"]);
  expect(
    fake.state.workerDomains
      .get(OWNER)
      ?.map((row) => [row.hostname, row.service]),
  ).toEqual([
    ["auth.example.com", "cloudysuite"],
    ["mail.example.com", "cloudysuite"],
  ]);

  const writesAfterFirstRun = fake.writes().length;
  const again = await runEverything({ secret: "already-set" });
  expect(again.map((result) => result.state)).toEqual([
    "done",
    "done",
    "done",
    "done",
    "done",
  ]);
  expect(fake.writes().length).toBe(writesAfterFirstRun);
});

test("a check never changes anything", async () => {
  for (const stepId of STEP_IDS) {
    expect((await runStep(stepId, "check")).state).toBe("missing");
  }
  expect(fake.writes()).toEqual([]);
});

test("a step that fails partway reports it, and a repeat finishes only what's left", async () => {
  fake.failOnce({
    method: "PUT",
    path: /workers\/domains$/,
    status: 500,
    message: "Cloudflare is having a moment",
    skip: 1,
  });
  expect(await runStep("app-hostnames")).toEqual({
    state: "failed",
    message: "Cloudflare said: Cloudflare is having a moment",
  });
  expect(
    fake.state.workerDomains.get(OWNER)?.map((row) => row.hostname),
  ).toEqual(["auth.example.com"]);

  expect((await runStep("app-hostnames")).state).toBe("done");
  expect(
    fake.state.workerDomains.get(OWNER)?.map((row) => row.hostname),
  ).toEqual(["auth.example.com", "mail.example.com"]);
  const attempts = fake.calls.filter(
    (call) => call.method === "PUT" && call.path.endsWith("workers/domains"),
  );
  // auth, the failed mail, then mail alone.
  expect(attempts.length).toBe(3);
});

test("a step Cloudflare accepted but did not make becomes a job for the person", async () => {
  const original = fake.fetch;
  deps.fetch = async (url, init) => {
    if (init.method === "PUT" && url.endsWith("catch_all")) {
      return Response.json({ success: true, result: {} });
    }
    return original(url, init);
  };
  const result = await runStep("catch-all");
  expect(result.state).toBe("needs-action");
  if (result.state === "needs-action") {
    expect(result.guide.action).toContain("catch-all");
    expect(result.guide.dashboardUrl).toStartWith(
      "https://dash.cloudflare.com/",
    );
    expect(result.guide.docsUrl).toStartWith(
      "https://developers.cloudflare.com/",
    );
  }
});

test("a manual step stays open until a check sees the change, and Check again never applies it", async () => {
  fake.state.zones.get(ZONE)?.dns.push({
    type: "MX",
    name: "example.com",
    content: "mx.oldmail.example.net",
    priority: 10,
  });

  for (const mode of ["run", "check", "run"] as const) {
    const result = await runStep("email-routing", mode);
    expect(result.state).toBe("needs-action");
    if (result.state === "needs-action")
      expect(result.guide.action).toContain("mx.oldmail.example.net");
  }
  expect(fake.writes()).toEqual([]);

  const zone = fake.state.zones.get(ZONE);
  if (zone) zone.dns = [];
  expect((await runStep("email-routing", "check")).state).toBe("missing");
  expect(fake.state.zones.get(ZONE)?.routing.enabled).toBe(false);
  expect((await runStep("email-routing", "run")).state).toBe("done");
});

test("an existing record on an app hostname asks the person to clear it", async () => {
  fake.state.zones.get(ZONE)?.dns.push({
    type: "CNAME",
    name: "mail.example.com",
    content: "ghs.example.net",
  });
  const result = await runStep("app-hostnames");
  expect(result.state).toBe("needs-action");
  expect(fake.state.workerDomains.get(OWNER)).toBeUndefined();
});

test("a hostname held by another Worker is not taken over", async () => {
  fake.state.workerDomains.set(OWNER, [
    {
      hostname: "auth.example.com",
      service: "someone-else",
      zone_id: ZONE,
    } as never,
  ]);
  const result = await runStep("app-hostnames");
  expect(result.state).toBe("needs-action");
  if (result.state === "needs-action")
    expect(result.guide.action).toContain("someone-else");
});

test("a denied step explains the permission, and does not call itself failed", async () => {
  const permissions = fake.state.tokens.get(OWNER_TOKEN)!.permissions;
  fake.addToken(
    OWNER_TOKEN,
    OWNER,
    permissions.filter((name) => name !== "routing-rules:write"),
  );
  const result = await runStep("catch-all");
  expect(result.state).toBe("needs-action");
  if (result.state === "needs-action") {
    expect(result.guide.action).toContain("isn't allowed");
    expect(result.guide.action).toContain("Email Routing Rules: Edit");
  }
});

test.each([
  ["email-routing", "Zone Settings: Edit"],
  ["email-sending", "Email Sending: Edit"],
  ["catch-all", "Email Routing Rules: Edit"],
  ["app-hostnames", "Workers Scripts: Edit"],
  ["auth-secret", "Workers Scripts: Edit"],
] as const)(
  "an authentication error on %s names %s, whatever the status",
  async (stepId, permission) => {
    const original = fake.fetch;
    let intercepted = false;
    deps.fetch = async (url, init) => {
      const proof = /\/(script-settings|versions\/[^/]+)$|\/zones\/[^/]+$/.test(
        url,
      );
      if (proof || intercepted) return original(url, init);
      intercepted = true;
      return Response.json(
        {
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        },
        { status: 400 },
      );
    };
    const result = await runStep(stepId);
    expect(result.state).toBe("needs-action");
    if (result.state === "needs-action")
      expect(result.guide.action).toContain(permission);
  },
);

// The live run: Cloudflare adds its records as soon as sending is turned on, and
// its two endpoints write the MX content differently.
test("the sending step finishes on the records Cloudflare added itself", async () => {
  const before = await runStep("email-sending", "check");
  expect(before.state === "missing" && before.detail).toContain("DMARC record");
  const result = await runStep("email-sending");
  expect(result.state).toBe("done");
  expect(result.state === "done" && result.detail).toContain("DMARC record");
  const records = fake.state.zones.get(ZONE)?.dns ?? [];
  expect(records.find(({ type }) => type === "MX")?.content).toBe(
    "route1.mx.cloudflare.net",
  );
  expect(
    records.find(({ name }) => name === "_dmarc.example.com")?.content,
  ).toBe('"v=DMARC1; p=reject;"');
  expect(
    fake.writes().filter((call) => call.path.endsWith("/dns_records")),
  ).toEqual([]);
});

const sendingRecord = (name: string) =>
  fake.state.zones
    .get(ZONE)
    ?.dns.find((record) => record.name === name && record.type === "TXT");

test("a long value split into several quoted strings counts as the same record", async () => {
  expect((await runStep("email-sending")).state).toBe("done");
  const dkim = sendingRecord("cf-bounce._domainkey.example.com");
  if (!dkim) throw new Error("no DKIM record");
  dkim.content = '"v=DKIM1; h=sha256; k=rsa; p=FakeKey" "WithMixedCase"';

  expect((await runStep("email-sending", "check")).state).toBe("done");
});

test("a key that differs only in case is a different key", async () => {
  expect((await runStep("email-sending")).state).toBe("done");
  const dkim = sendingRecord("cf-bounce._domainkey.example.com");
  if (!dkim) throw new Error("no DKIM record");
  dkim.content = dkim.content.toLowerCase();

  expect((await runStep("email-sending", "check")).state).toBe("missing");
});

test("a record that appears while the step runs doesn't fail it", async () => {
  await runStep("email-sending");
  const zone = fake.state.zones.get(ZONE);
  if (!zone) throw new Error("no zone");
  const added = zone.dns.filter(({ type }) => type === "MX");
  zone.dns = zone.dns.filter(({ type }) => type !== "MX");

  const original = fake.fetch;
  deps.fetch = async (url, init) => {
    if (init.method === "POST" && url.endsWith("/dns_records"))
      zone.dns.push(...added);
    return original(url, init);
  };
  expect((await runStep("email-sending")).state).toBe("done");
});

test("when Cloudflare calls a record identical but the check can't see it, the step names the record", async () => {
  await runStep("email-sending");
  const zone = fake.state.zones.get(ZONE);
  if (!zone) throw new Error("no zone");
  zone.dns = zone.dns.filter(
    ({ name }) => name !== "cf-bounce._domainkey.example.com",
  );
  fake.failOnce({
    method: "POST",
    path: /dns_records$/,
    status: 400,
    code: 81058,
    message: "An identical record already exists.",
  });
  const result = await runStep("email-sending");
  expect(result.state).toBe("needs-action");
  if (result.state === "needs-action")
    expect(result.guide.action).toContain("cf-bounce._domainkey.example.com");
});

test("any other refusal to add a record still fails the step", async () => {
  await runStep("email-sending");
  const zone = fake.state.zones.get(ZONE);
  if (!zone) throw new Error("no zone");
  zone.dns = zone.dns.filter(({ type }) => type !== "MX");
  fake.failOnce({
    method: "POST",
    path: /dns_records$/,
    status: 400,
    code: 1004,
    message: "DNS validation failed",
  });
  expect(await runStep("email-sending")).toEqual({
    state: "failed",
    message: "Cloudflare said: DNS validation failed",
  });
});

test("an existing DMARC record stays as it is", async () => {
  const zone = fake.state.zones.get(ZONE);
  zone?.dns.push({
    type: "TXT",
    name: "_dmarc.example.com",
    content: "v=DMARC1; p=none; rua=mailto:reports@example.com",
  });
  expect((await runStep("email-sending")).state).toBe("done");
  expect(
    zone?.dns
      .filter(({ name }) => name === "_dmarc.example.com")
      .map(({ content }) => content),
  ).toEqual(["v=DMARC1; p=none; rua=mailto:reports@example.com"]);
  expect(
    fake.writes().filter((call) => call.path.endsWith("/dns_records")),
  ).toEqual([]);
});

test("the sending step adds only missing records, and leaves an existing SPF for the person", async () => {
  const zone = fake.state.zones.get(ZONE);
  zone?.dns.push({
    type: "TXT",
    name: "_dmarc.example.com",
    content: "v=DMARC1; p=reject",
  });
  zone?.dns.push({
    type: "TXT",
    name: "cf-bounce.example.com",
    content: "v=spf1 include:other ~all",
  });
  const result = await runStep("email-sending");
  expect(result.state).toBe("needs-action");
  if (result.state === "needs-action")
    expect(result.guide.action).toContain("v=spf1 include:_spf");
  const dmarc = zone?.dns.filter(
    (record) => record.name === "_dmarc.example.com",
  );
  expect(dmarc?.map((record) => record.content)).toEqual([
    "v=DMARC1; p=reject",
  ]);
});

test("an SPF record merged by hand passes the sending check", async () => {
  const zone = fake.state.zones.get(ZONE);
  const spf = {
    type: "TXT",
    name: "cf-bounce.example.com",
    content: "v=spf1 include:other ~all",
  };
  zone?.dns.push(spf);
  expect((await runStep("email-sending")).state).toBe("needs-action");

  spf.content = '"v=spf1 include:other include:_spf.mx.cloudflare.net ~all"';
  expect((await runStep("email-sending", "check")).state).toBe("done");
});

test("the secret is set when missing and then never replaced", async () => {
  await runStep("auth-secret");
  const worker = fake.state.accounts.get(OWNER)?.workers.get("cloudysuite");
  expect(worker?.secrets.has("BETTER_AUTH_SECRET")).toBe(true);
  const writes = fake.writes().length;

  const waiting = await runStep("auth-secret");
  expect(waiting).toMatchObject({ state: "needs-action", retry: true });
  expect(
    await runStep("auth-secret", "run", { secret: "now-visible" }),
  ).toMatchObject({ state: "done" });
  expect(fake.writes().length).toBe(writes);
});

test("finish refuses while a step is unfinished, and stores nothing", async () => {
  const { status, body } = await post(
    { action: "finish", claim, choice, admin },
    { secret: "s".repeat(40) },
  );
  expect(status).toBe(409);
  expect(body.error.code).toBe("steps-unfinished");
  expect(count("user")).toBe(0);
  expect(count("domains")).toBe(0);
});

const SECRET = "test-secret-test-secret-test-secret-0123";

async function signIn(appDomain: string, email = admin.email) {
  const auth = createAuth({
    database: d1,
    secret: SECRET,
    primaryDomain: appDomain,
    origins: appOrigins(appDomain, new Request(`https://auth.${appDomain}/`)),
  });
  return auth.handler(
    new Request(`https://auth.${appDomain}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `https://auth.${appDomain}`,
      },
      body: JSON.stringify({ email, password: admin.password }),
    }),
  );
}

test("finish creates the admin and mailbox, and the admin can sign in", async () => {
  await runEverything({ secret: SECRET });
  const { status, body } = await post(
    { action: "finish", claim, choice, admin },
    { secret: SECRET },
  );
  expect(status).toBe(200);
  expect(body.authUrl).toBe("https://auth.example.com/");

  expect(sqlite.query("SELECT name, is_primary FROM domains").all()).toEqual([
    { name: "example.com", is_primary: 1 },
  ]);
  expect(sqlite.query("SELECT email, role FROM user").all()).toEqual([
    { email: admin.email, role: "admin" },
  ]);
  expect(
    sqlite.query("SELECT address, domain, kind FROM addresses").all(),
  ).toEqual([
    { address: "ada@example.com", domain: "example.com", kind: "primary" },
  ]);
  expect(sqlite.query("SELECT kind, name FROM mailboxes").all()).toEqual([
    { kind: "personal", name: admin.name },
  ]);
  expect(sqlite.query("SELECT role FROM mailbox_access").all()).toEqual([
    { role: "manager" },
  ]);
  expect((await signIn("example.com")).status).toBe(200);
});

test("with a parent domain, apps sit under it while email stays on the apex", async () => {
  const parent = { zoneId: ZONE, appLabel: "suite" };
  for (const stepId of STEP_IDS) {
    await post(
      { action: "step", claim, choice: parent, stepId, mode: "run" },
      { secret: SECRET },
    );
  }
  expect(
    fake.state.workerDomains.get(OWNER)?.map((row) => row.hostname),
  ).toEqual(["auth.suite.example.com", "mail.suite.example.com"]);
  expect(fake.state.zones.get(ZONE)?.sending.map((row) => row.name)).toEqual([
    "example.com",
  ]);

  const { body } = await post(
    { action: "finish", claim, choice: parent, admin },
    { secret: SECRET },
  );
  expect(body.authUrl).toBe("https://auth.suite.example.com/");
  expect(
    sqlite.query("SELECT name, is_primary FROM domains ORDER BY name").all(),
  ).toEqual([
    { name: "example.com", is_primary: 0 },
    { name: "suite.example.com", is_primary: 1 },
  ]);
  expect(sqlite.query("SELECT address FROM addresses").all()).toEqual([
    { address: "ada@example.com" },
  ]);

  const response = await signIn("suite.example.com");
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.includes("session_token"));
  expect(cookie).toContain("Domain=suite.example.com");
});

test("a finish that stops before its commit stores nothing, and a retry works", async () => {
  await runEverything({ secret: SECRET });
  const failing = {
    ...d1,
    prepare: d1.prepare,
    // Reading settings is a batch of two. Only the commit is larger.
    batch: async (statements: never[]) => {
      if (statements.length > 2) throw new Error("D1 is unavailable");
      return d1.batch(statements);
    },
  } as unknown as D1Database;

  const crashed = await post(
    {
      action: "finish",
      claim,
      choice,
      admin: { ...admin, email: "typo@other.example.net" },
    },
    { secret: SECRET, database: failing },
  );
  expect(crashed.status).toBe(500);
  for (const table of ["domains", "user", "account", "mailboxes"])
    expect(count(table)).toBe(0);

  const retried = await post(
    { action: "finish", claim, choice, admin },
    { secret: SECRET },
  );
  expect(retried.status).toBe(200);
  expect(sqlite.query("SELECT email FROM user").all()).toEqual([
    { email: admin.email },
  ]);
  expect((await signIn("example.com")).status).toBe(200);
});

function expectOneOfEverything() {
  for (const table of [
    "domains",
    "user",
    "account",
    "mailboxes",
    "addresses",
    "mailbox_access",
  ])
    expect(`${table}: ${count(table)}`).toBe(`${table}: 1`);
}

test.each([
  ["different emails", (i: number) => `person${i}@other.example.net`],
  ["the same email", () => admin.email],
])("parallel finishes with %s leave one admin", async (_name, email) => {
  await runEverything({ secret: SECRET });
  const admins = Array.from({ length: 5 }, (_, i) => ({
    ...admin,
    email: email(i),
    mailboxLocalPart: `person${i}`,
  }));
  const results = await Promise.all(
    admins.map((person) =>
      post(
        { action: "finish", claim, choice, admin: person },
        { secret: SECRET },
      ),
    ),
  );

  expect(results.filter(({ status }) => status === 200).length).toBe(1);
  for (const { status, body } of results) {
    if (status === 200) continue;
    expect(status).toBe(409);
    expect(body.error.code).toBe("already-finished");
    expect(body.error.message).toContain("nothing changed");
  }
  expectOneOfEverything();
  expect(sqlite.query("SELECT role FROM user").all()).toEqual([
    { role: "admin" },
  ]);

  const stored = sqlite.query("SELECT email FROM user").get() as {
    email: string;
  };
  expect((await signIn("example.com", stored.email)).status).toBe(200);
  const loser = admins.find((person) => person.email !== stored.email);
  if (loser)
    expect((await signIn("example.com", loser.email)).status).toBe(401);
});

test("creating the first admin after setup finished changes nothing", async () => {
  await runEverything({ secret: SECRET });
  await post({ action: "finish", claim, choice, admin }, { secret: SECRET });
  const tables = [
    "domains",
    "user",
    "account",
    "mailboxes",
    "addresses",
    "mailbox_access",
  ];
  const dump = () =>
    tables.map((table) => sqlite.query(`SELECT * FROM ${table}`).all());
  const before = dump();

  const auth = createAuth({
    database: d1,
    secret: SECRET,
    primaryDomain: "example.com",
    origins: appOrigins(
      "example.com",
      new Request("https://auth.example.com/"),
    ),
  });
  for (const appDomain of ["example.com", "suite.example.com", "other.test"]) {
    const created = await createFirstAdmin({
      database: d1,
      auth,
      plan: {
        zoneId: ZONE,
        zoneName: "example.com",
        emailDomain: "example.com",
        appDomain,
      },
      admin: {
        ...admin,
        email: "eve@other.example.net",
        mailboxLocalPart: "eve",
      },
    });
    expect(created).toBe(false);
  }
  expect(dump()).toEqual(before);
});

test("the first admin's rows have ids in Better Auth's own format", async () => {
  await runEverything({ secret: SECRET });
  const { status } = await post(
    { action: "finish", claim, choice, admin },
    { secret: SECRET },
  );
  expect(status).toBe(200);
  const auth = createAuth({
    database: d1,
    secret: SECRET,
    primaryDomain: "example.com",
    origins: appOrigins(
      "example.com",
      new Request("https://auth.example.com/"),
    ),
  });
  await auth.api.createUser({
    body: {
      email: "second@other.example.net",
      password: "correct horse battery",
      name: "Second",
      role: "user",
    },
  });
  const users = sqlite.query("SELECT id FROM user").all() as { id: string }[];
  const accounts = sqlite.query("SELECT id FROM account").all() as {
    id: string;
  }[];
  expect(users.length).toBe(2);
  expect(accounts.length).toBe(2);
  for (const { id } of [...users, ...accounts])
    expect(id).toMatch(/^[a-zA-Z0-9]{32}$/);
});

test("an address sign-in would refuse is refused at setup", async () => {
  await runEverything({ secret: SECRET });
  const { status } = await post(
    {
      action: "finish",
      claim,
      choice,
      admin: { ...admin, email: "a!b@other.example.net" },
    },
    { secret: SECRET },
  );
  expect(status).toBe(400);
  expect(count("user")).toBe(0);
});

test("once finished, nobody can run any part of setup again, even with the right token", async () => {
  await runEverything({ secret: SECRET });
  await post({ action: "finish", claim, choice, admin }, { secret: SECRET });

  for (const body of [
    { action: "claim", token: OWNER_TOKEN },
    { action: "step", claim, choice, stepId: "catch-all", mode: "run" },
    {
      action: "finish",
      claim,
      choice,
      admin: { ...admin, email: "b@other.example.net" },
    },
  ]) {
    const { status, body: response } = await post(body, { secret: SECRET });
    expect(status).toBe(409);
    expect(response.error.code).toBe("already-finished");
  }
  expect(count("user")).toBe(1);
});

test("bad input gets a plain refusal", async () => {
  for (const body of [
    null,
    { action: "claim" },
    { action: "step", claim, choice, stepId: "nope", mode: "run" },
    {
      action: "step",
      claim,
      choice: { zoneId: ZONE, appLabel: "auth" },
      stepId: "catch-all",
      mode: "run",
    },
    {
      action: "step",
      claim,
      choice: { zoneId: ZONE, appLabel: "a.b" },
      stepId: "catch-all",
      mode: "run",
    },
    { action: "finish", claim, choice, admin: { ...admin, password: "short" } },
    {
      action: "finish",
      claim,
      choice,
      admin: { ...admin, mailboxLocalPart: "a b" },
    },
    {
      action: "finish",
      claim,
      choice,
      admin: { ...admin, email: "no-at-sign" },
    },
  ]) {
    expect((await post(body)).status).toBe(400);
  }
  expect(fake.calls).toEqual([]);
});

test("a zone from another account cannot be chosen", async () => {
  const { status } = await post({
    action: "step",
    claim,
    choice: { zoneId: "cccccccccccccccccccccccccccccccc", appLabel: null },
    stepId: "catch-all",
    mode: "run",
  });
  expect(status).toBe(502);
  expect(fake.writes()).toEqual([]);
});

test("the token never reaches the database, a response, or the log", async () => {
  const logged: unknown[][] = [];
  const spies = [
    spyOn(console, "error").mockImplementation(
      (...args) => void logged.push(args),
    ),
    spyOn(console, "log").mockImplementation(
      (...args) => void logged.push(args),
    ),
    spyOn(console, "warn").mockImplementation(
      (...args) => void logged.push(args),
    ),
  ];
  const seen: string[] = [];
  const record = async (body: unknown, overrides = {}) => {
    seen.push(JSON.stringify(await post(body, overrides)));
  };

  try {
    await record({ action: "claim", token: OWNER_TOKEN });
    for (const stepId of STEP_IDS) {
      await record(
        { action: "step", claim, choice, stepId, mode: "run" },
        { secret: SECRET },
      );
    }
    await record(
      { action: "finish", claim, choice, admin },
      { secret: SECRET },
    );

    // Now the same token, as an unfinished setup would see it, with Cloudflare
    // repeating the token in its errors.
    sqlite.run("DELETE FROM addresses");
    sqlite.run("DELETE FROM domains");
    fake.echoTokenInErrors();
    fake.failOnce({
      method: "GET",
      path: /email\/routing$/,
      status: 500,
      message: `boom ${OWNER_TOKEN}`,
    });
    await record({
      action: "step",
      claim,
      choice,
      stepId: "email-routing",
      mode: "check",
    });
    await record({
      action: "claim",
      token: "wrong-token-wrong-token-wrong-token",
    });
    await record({
      action: "step",
      claim: { ...claim, token: "wrong-token-wrong-token-wrong-token" },
      choice,
      stepId: "catch-all",
      mode: "run",
    });
    fake.state.tokens.delete(OWNER_TOKEN);
    await record({
      action: "step",
      claim,
      choice,
      stepId: "catch-all",
      mode: "run",
    });
    await record({ action: "claim", token: OWNER_TOKEN });
    // The fake cannot be reached at all.
    await record(
      { action: "claim", token: OWNER_TOKEN },
      {
        fetch: () =>
          Promise.reject(new Error(`no route, token ${OWNER_TOKEN}`)),
      },
    );
    // The database itself breaks, and its error repeats the token.
    await record(
      { action: "claim", token: OWNER_TOKEN },
      {
        database: {
          prepare: () => {
            throw new Error(`broken ${OWNER_TOKEN}`);
          },
        },
      },
    );
  } finally {
    for (const spy of spies) spy.mockRestore();
  }

  const responses = seen.join("\n");
  expect(responses).not.toContain(OWNER_TOKEN);
  expect(responses).not.toContain("wrong-token-wrong-token-wrong-token");
  expect(responses).toContain("[token hidden]");
  expect(JSON.stringify(logged)).not.toContain(OWNER_TOKEN);

  const tables = sqlite
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  const dump = tables.map(({ name }) =>
    JSON.stringify(sqlite.query(`SELECT * FROM "${name}"`).all()),
  );
  expect(dump.join("\n")).not.toContain(OWNER_TOKEN);
});

test("the DNS scan recommends the apex only when no other site is hosted there", () => {
  expect(
    scanZone("example.com", [], [], "cloudysuite").recommendedLabel,
  ).toBeNull();

  const quiet = scanZone(
    "example.com",
    [
      { type: "TXT", name: "example.com", content: "v=spf1 -all" },
      {
        type: "CNAME",
        name: "_acme.example.com",
        content: "validate.example.net",
      },
      { type: "AAAA", name: "auth.example.com", content: "100::" },
    ],
    [{ hostname: "auth.example.com", service: "cloudysuite" }],
    "cloudysuite",
  );
  expect(quiet.hostedHosts).toEqual([]);
  expect(quiet.recommendedLabel).toBeNull();

  const busy = scanZone(
    "example.com",
    [
      {
        type: "CNAME",
        name: "www.example.com",
        content: "hosting.example.net",
      },
      { type: "A", name: "example.com", content: "192.0.2.1" },
      { type: "A", name: "suite.example.com", content: "192.0.2.2" },
      { type: "MX", name: "example.com", content: "mx.oldmail.example.net." },
      { type: "MX", name: "example.com", content: "route1.mx.cloudflare.net" },
    ],
    [],
    "cloudysuite",
  );
  expect(busy.hostedHosts).toEqual([
    "example.com",
    "suite.example.com",
    "www.example.com",
  ]);
  expect(busy.recommendedLabel).toBe("apps");
  expect(busy.externalMx).toEqual(["mx.oldmail.example.net"]);
});

test("a reloaded wizard reads its earlier choice back from Cloudflare", async () => {
  fake.state.workerDomains.set(OWNER, [
    {
      hostname: "auth.suite.example.com",
      service: "cloudysuite",
      zone_id: ZONE,
    } as never,
  ]);
  fake.state.zones.get(ZONE)?.dns.push({
    type: "AAAA",
    name: "auth.suite.example.com",
    content: "100::",
  });
  const { body } = await post({ action: "scan", claim, zoneId: ZONE });
  expect(body.scan.resumedLabel).toBe("suite");
  expect(body.scan.hostedHosts).toEqual([]);
});

test("the token form link fills in every permission the wizard needs", () => {
  const url = new URL(tokenFormUrl());
  expect(url.origin).toBe("https://dash.cloudflare.com");
  expect(url.searchParams.get("to")).toBe("/:account/api-tokens");
  expect(url.searchParams.get("name")).toBe("CloudySuite setup");
  const filled = JSON.parse(
    url.searchParams.get("permissionGroupKeys") ?? "[]",
  );
  expect(filled).toEqual([
    { key: "workers_scripts", type: "edit" },
    { key: "5df633d6b41c42bcaf5b4a62b9d14b64", type: "edit" },
    { key: "zone", type: "read" },
    { key: "dns", type: "edit" },
    { key: "zone_settings", type: "edit" },
    { key: "79b3ec0d10ce4148a8f8bdc0cc5f97f2", type: "edit" },
  ]);
  expect(
    TOKEN_PERMISSIONS.filter(({ scope }) => scope === "account").map(
      ({ label }) => label,
    ),
  ).toEqual(["Workers Scripts", "Email Sending"]);
});

test("only a loopback address can replace Cloudflare's API", () => {
  expect(cloudflareApiBase(undefined)).toBe(CLOUDFLARE_API);
  expect(cloudflareApiBase("not a url")).toBe(CLOUDFLARE_API);
  expect(cloudflareApiBase("https://evil.example.net/client/v4")).toBe(
    CLOUDFLARE_API,
  );
  expect(cloudflareApiBase("https://localhost.evil.example.net")).toBe(
    CLOUDFLARE_API,
  );
  expect(cloudflareApiBase("http://localhost:8799/client/v4")).toBe(
    "http://localhost:8799/client/v4",
  );
  expect(cloudflareApiBase("http://127.0.0.1:8799/client/v4/")).toBe(
    "http://127.0.0.1:8799/client/v4",
  );
});

const FORWARD = {
  enabled: true,
  actions: [{ type: "forward", value: ["ada@old.example"] }],
};
const OTHER_WORKER = {
  enabled: true,
  actions: [{ type: "worker", value: ["old-mail"] }],
};

const stepBody = (extra: object = {}) => ({
  action: "step",
  claim,
  choice,
  stepId: "catch-all",
  mode: "run",
  ...extra,
});

const catchAll = () => fake.state.zones.get(ZONE)?.catchAll;

test.each([
  ["a forward", FORWARD, "is forwarded to ada@old.example"],
  ["another Worker", OTHER_WORKER, "goes to another Worker, old-mail"],
  [
    "a delete rule",
    { enabled: true, actions: [{ type: "drop" }] },
    "is deleted",
  ],
])(
  "a catch-all that is %s stays until the person confirms it",
  async (_name, rule, words) => {
    const zone = fake.state.zones.get(ZONE);
    if (zone) zone.catchAll = rule;

    const checked = await runStep("catch-all", "check");
    expect(checked.state).toBe("needs-confirmation");
    if (checked.state !== "needs-confirmation") throw new Error(checked.state);
    expect(checked.current).toContain(words);

    const refused = [
      stepBody(),
      stepBody({ confirmReplace: "yes" }),
      stepBody({ mode: "check", confirmReplace: checked.current }),
    ];
    for (const body of refused) {
      const { status, body: response } = await post(body);
      expect(status).toBe(200);
      expect(response.result).toEqual(checked);
    }
    expect(catchAll()).toEqual(rule);
    expect(fake.writes()).toEqual([]);

    const { body } = await post(stepBody({ confirmReplace: checked.current }));
    expect(body.result.state).toBe("done");
    expect(catchAll()).toEqual({
      enabled: true,
      actions: [{ type: "worker", value: ["cloudysuite"] }],
    });
  },
);

test("a confirmation for one unrecognised rule does not cover another", async () => {
  const zone = fake.state.zones.get(ZONE);
  const first = { enabled: true, actions: [{ type: "archive", value: ["a"] }] };
  const second = {
    enabled: true,
    actions: [{ type: "archive", value: ["b"] }],
  };
  if (zone) zone.catchAll = first;
  const seen = await runStep("catch-all", "check");
  if (seen.state !== "needs-confirmation") throw new Error(seen.state);
  expect(seen.current).toContain('{"type":"archive","value":["a"]}');

  if (zone) zone.catchAll = second;
  const { body } = await post(stepBody({ confirmReplace: seen.current }));
  expect(body.result.state).toBe("needs-confirmation");
  expect(body.result.current).toContain('{"type":"archive","value":["b"]}');
  expect(catchAll()).toEqual(second);
});

test("a confirmation does not cover a rule that changed since the person saw it", async () => {
  const zone = fake.state.zones.get(ZONE);
  if (zone) zone.catchAll = FORWARD;
  const seen = await runStep("catch-all", "check");
  if (seen.state !== "needs-confirmation") throw new Error(seen.state);

  if (zone) zone.catchAll = OTHER_WORKER;
  const { body } = await post(stepBody({ confirmReplace: seen.current }));
  expect(body.result.state).toBe("needs-confirmation");
  expect(body.result.current).toContain("old-mail");
  expect(catchAll()).toEqual(OTHER_WORKER);
});

test("finish refuses while a catch-all waits for confirmation", async () => {
  await runEverything({ secret: SECRET });
  const zone = fake.state.zones.get(ZONE);
  if (zone) zone.catchAll = FORWARD;
  const { status, body } = await post(
    { action: "finish", claim, choice, admin },
    { secret: SECRET },
  );
  expect(status).toBe(409);
  expect(body.error.code).toBe("steps-unfinished");
  expect(count("user")).toBe(0);
});

test("a catch-all Cloudflare won't describe is left alone", async () => {
  const original = fake.fetch;
  deps.fetch = async (url, init) =>
    init.method === "GET" && url.endsWith("catch_all")
      ? Response.json({ success: true, result: null })
      : original(url, init);
  const result = await runStep("catch-all");
  expect(result.state).toBe("needs-action");
  expect(fake.writes()).toEqual([]);
});

test("a confirmation that isn't text is a bad request", async () => {
  const { status } = await post(stepBody({ confirmReplace: true }));
  expect(status).toBe(400);
  expect(fake.calls).toEqual([]);
});

test("an existing site on an app name counts as hosted, and is not overwritten", async () => {
  const record = { type: "A", name: "mail.example.com", content: "192.0.2.1" };
  fake.state.zones.get(ZONE)?.dns.push(record);

  const { body } = await post({ action: "scan", claim, zoneId: ZONE });
  expect(body.scan.hostedHosts).toEqual(["mail.example.com"]);
  expect(body.scan.recommendedLabel).toBe("suite");

  const result = await runStep("app-hostnames");
  expect(result.state).toBe("needs-action");
  if (result.state === "needs-action")
    expect(result.guide.action).toContain("mail.example.com");
  expect(fake.writes()).toEqual([]);
  expect(fake.state.zones.get(ZONE)?.dns).toEqual([record]);
});

test("an app name on another Worker counts as hosted", async () => {
  fake.state.workerDomains.set(OWNER, [
    {
      hostname: "auth.example.com",
      service: "someone-else",
      zone_id: ZONE,
    } as never,
  ]);
  const { body } = await post({ action: "scan", claim, zoneId: ZONE });
  expect(body.scan.hostedHosts).toEqual(["auth.example.com"]);
  expect(body.scan.recommendedLabel).toBe("suite");
});

test("a repeat run's own app names don't count as hosted", async () => {
  await runStep("app-hostnames");
  const zone = fake.state.zones.get(ZONE);
  for (const name of ["auth.example.com", "mail.example.com"])
    zone?.dns.push({ type: "AAAA", name, content: "100::" });

  const { body } = await post({ action: "scan", claim, zoneId: ZONE });
  expect(body.scan.hostedHosts).toEqual([]);
  expect(body.scan.recommendedLabel).toBeNull();
  expect(body.scan.resumedLabel).toBeNull();
});

test.each([
  ["no result", null],
  ["another version", { id: "some-other-version" }],
  ["a result with no id", {}],
])("a version lookup with %s proves nothing", async (_name, result) => {
  const original = fake.fetch;
  deps.fetch = async (url, init) =>
    url.includes("/versions/")
      ? Response.json({ success: true, result })
      : original(url, init);
  const claimed = await post({ action: "claim", token: OWNER_TOKEN });
  expect(claimed.status).toBe(403);
  const stepped = await post(stepBody());
  expect(stepped.status).toBe(403);
  expect(fake.writes()).toEqual([]);
});

test("a zone lookup with no result stops the step", async () => {
  const original = fake.fetch;
  deps.fetch = async (url, init) =>
    url.endsWith(`/zones/${ZONE}`)
      ? Response.json({ success: true, result: null })
      : original(url, init);
  const spy = spyOn(console, "error").mockImplementation(() => {});
  const { status } = await post(stepBody());
  spy.mockRestore();
  expect(status).toBe(500);
  expect(fake.writes()).toEqual([]);
});

test("Cloudflare's text reaches only a proven owner", async () => {
  const secretText = `script cloudysuite at version ${VERSION}`;
  for (const path of [/\/versions\//, /script-settings$/]) {
    for (const body of [{ action: "claim", token: OWNER_TOKEN }, stepBody()]) {
      fake.failOnce({ method: "GET", path, status: 500, message: secretText });
      const response = await post(body);
      expect(response.status).toBe(502);
      expect(JSON.stringify(response.body)).not.toContain(VERSION);
      expect(response.body.error.message).toContain(
        "couldn't check your token",
      );
    }
  }

  fake.failOnce({
    method: "GET",
    path: /email\/routing\/rules\/catch_all$/,
    status: 500,
    message: "the rule store is down",
  });
  expect(await runStep("catch-all")).toEqual({
    state: "failed",
    message: "Cloudflare said: the rule store is down",
  });
});

test("the proof writes back the Worker's settings exactly as they were", async () => {
  const worker = fake.state.accounts.get(OWNER)?.workers.get("cloudysuite");
  if (!worker) throw new Error("no worker");
  const settings = {
    logpush: true,
    observability: {
      enabled: true,
      head_sampling_rate: 0.5,
      traces: { enabled: true },
    },
    tags: ["team-a"],
    tail_consumers: [{ service: "log-reader" }],
  };
  worker.settings = {
    ...settings,
    observability: {
      ...settings.observability,
      traces: { enabled: true, propagation_policy: null },
    },
  };

  expect((await post({ action: "claim", token: OWNER_TOKEN })).status).toBe(
    200,
  );
  expect((await post(stepBody({ mode: "check" }))).status).toBe(200);

  const patches = fake.calls.filter((call) => call.method === "PATCH");
  expect(patches.length).toBe(2);
  for (const patch of patches) expect(patch.body).toEqual(settings);
  const reads = fake.calls.filter(
    (call) => call.method === "GET" && call.path.endsWith("/script-settings"),
  );
  expect(reads.length).toBe(2);
  expect(worker.settings).toMatchObject(settings);
});

test("default settings with nothing set write back cleanly", async () => {
  expect((await post({ action: "claim", token: OWNER_TOKEN })).status).toBe(
    200,
  );
  const [patch] = fake.calls.filter((call) => call.method === "PATCH");
  expect(patch?.body).toEqual({ logpush: false });
});

test.each([
  ["no result", null],
  ["an empty result", {}],
  ["only unset settings", { logpush: null, tags: null }],
  ["only settings we don't know", { something_new: true }],
])(
  "a settings read with %s refuses the proof and writes nothing",
  async (_name, result) => {
    const original = fake.fetch;
    deps.fetch = async (url, init) =>
      url.endsWith("/script-settings") && init.method === "GET"
        ? Response.json({ success: true, result })
        : original(url, init);
    const { status, body } = await post({
      action: "claim",
      token: OWNER_TOKEN,
    });
    expect(status).toBe(403);
    expect(body.error.message).toContain("Nothing was changed");
    expect(fake.calls.filter((call) => call.method === "PATCH")).toEqual([]);
  },
);

test("a settings write with no result proves nothing", async () => {
  const original = fake.fetch;
  deps.fetch = async (url, init) =>
    url.endsWith("/script-settings") && init.method === "PATCH"
      ? Response.json({ success: true, result: null })
      : original(url, init);
  const { status, body } = await post({ action: "claim", token: OWNER_TOKEN });
  expect(status).toBe(502);
  expect(body.error.message).toContain("couldn't check your token");
});
