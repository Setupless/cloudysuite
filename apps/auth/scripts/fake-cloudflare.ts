// Local only: serves the fake Cloudflare API so that `wrangler dev` can run the
// setup wizard without a real account. See the README's "Try the wizard locally".
import { appendFileSync } from "node:fs";
import { createFakeCloudflare } from "../src/setup/fake-cloudflare";

const OWNER = "0123456789abcdef0123456789abcdef";
const STRANGER = "fedcba9876543210fedcba9876543210";
const DEV_VARS = ".dev.vars";

// Workers on Cloudflare restart on their own when a secret changes. Locally, a
// restart of the dev server does the same: it reads this file and gets a new version id.
const fake = createFakeCloudflare({
  onSecretSet(name, text) {
    appendFileSync(DEV_VARS, `\n${name}=${text}\n`);
    console.log(`Set the secret ${name}. Restart the dev server to see it.`);
  },
});
fake.addAccount(OWNER, "Example Org");
fake.addWorker(
  OWNER,
  "an-older-worker",
  ["11111111-1111-4111-8111-111111111111"],
  "2020-01-01T00:00:00Z",
);
fake.addWorker(OWNER, "cloudysuite", "any", "2026-11-01T00:00:00Z");
const running = fake.state.accounts.get(OWNER)?.workers.get("cloudysuite");
if (running) {
  running.settings = {
    logpush: true,
    observability: { enabled: true, head_sampling_rate: 0.5 },
    tags: ["team-a"],
    tail_consumers: [{ service: "log-reader" }],
  };
}
fake.addZone(OWNER, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "quiet.localhost");
fake.addZone(OWNER, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "busy.localhost", [
  { type: "CNAME", name: "www.busy.localhost", content: "hosting.example.net" },
  {
    type: "MX",
    name: "busy.localhost",
    content: "mx.oldmail.example.net",
    priority: 10,
  },
]);
fake.addToken("owner-token-owner-token-owner-token", OWNER);
fake.addToken("read-only-token-read-only-token", OWNER, [
  "workers:read",
  "zone:read",
]);
fake.addAccount(STRANGER, "Stranger");
fake.addWorker(STRANGER, "their-own-worker", [
  "22222222-2222-4222-8222-222222222222",
]);
fake.addZone(
  STRANGER,
  "cccccccccccccccccccccccccccccccc",
  "stranger.localhost",
);
fake.addToken("stranger-token-stranger-token-stranger", STRANGER);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 8799,
  fetch(request) {
    const { pathname } = new URL(request.url);
    // Lets a manual run clear the MX record that blocks busy.localhost.
    if (pathname === "/__delete-external-mx") {
      const zone = fake.state.zones.get("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      if (zone) zone.dns = zone.dns.filter((record) => record.type !== "MX");
      return new Response("deleted\n");
    }
    // Shows what the proof wrote, so a manual run can see it changed nothing.
    if (pathname === "/__settings") {
      return Response.json({
        current: running?.settings,
        patches: fake.calls.filter(({ method }) => method === "PATCH"),
      });
    }
    return fake.fetch(request);
  },
});
console.log(`Fake Cloudflare API on http://127.0.0.1:${server.port}/client/v4`);
