// A stand-in for the parts of Cloudflare's API the wizard uses, for the unit
// tests and for the local end-to-end run. Production code never imports this.
import type { DnsRecord, WorkerDomain } from "./cloudflare";

export type FakePermission =
  | "workers:read"
  | "workers:write"
  | "zone:read"
  | "dns:read"
  | "dns:write"
  | "zone-settings:write"
  | "routing-rules:write"
  | "sending:write";

export const ALL_PERMISSIONS: readonly FakePermission[] = [
  "workers:read",
  "workers:write",
  "zone:read",
  "dns:read",
  "dns:write",
  "zone-settings:write",
  "routing-rules:write",
  "sending:write",
];

type FakeToken = { accountId: string; permissions: readonly FakePermission[] };

type FakeWorker = {
  versions: string[];
  // `wrangler dev` gives the running Worker a new random version id at each
  // reload, and the local fake cannot learn it, so it accepts any for this Worker.
  anyVersion: boolean;
  secrets: Set<string>;
  modifiedOn: string;
  settings: Record<string, unknown>;
};

type FakeZone = {
  id: string;
  name: string;
  accountId: string;
  status: string;
  dns: DnsRecord[];
  routing: { enabled: boolean; status: string };
  catchAll: { enabled: boolean; actions: { type: string; value?: string[] }[] };
  sending: { tag: string; name: string; enabled: boolean }[];
};

export type FakeState = {
  tokens: Map<string, FakeToken>;
  accounts: Map<string, { name: string; workers: Map<string, FakeWorker> }>;
  zones: Map<string, FakeZone>;
  workerDomains: Map<string, WorkerDomain[]>;
};

type Failure = {
  method: string;
  path: RegExp;
  status: number;
  message: string;
  code?: number;
  // Let this many matching calls through first.
  skip?: number;
};

// What the live API returned: MX content ends in a dot here, but not in
// `dns_records`, and the DMARC record is `p=reject`.
const SENDING_RECORDS = (domain: string): DnsRecord[] => [
  {
    type: "MX",
    name: `cf-bounce.${domain}`,
    content: "route1.mx.cloudflare.net.",
    priority: 10,
  },
  {
    type: "TXT",
    name: `cf-bounce.${domain}`,
    content: "v=spf1 include:_spf.mx.cloudflare.net ~all",
  },
  {
    type: "TXT",
    name: `cf-bounce._domainkey.${domain}`,
    content: "v=DKIM1; h=sha256; k=rsa; p=FakeKeyWithMixedCase",
  },
  { type: "TXT", name: `_dmarc.${domain}`, content: "v=DMARC1; p=reject;" },
];

const POLICY = /^"?v=(spf1|dmarc1)/i;

const storedForm = (record: DnsRecord): DnsRecord =>
  record.type === "TXT"
    ? { ...record, content: `"${record.content}"` }
    : { ...record, content: record.content.replace(/\.$/, "") };

const identityOf = ({ type, name, content }: DnsRecord) => {
  const value =
    type === "TXT"
      ? content.replace(/" +"/g, "").replace(/^"|"$/g, "")
      : content.toLowerCase().replace(/\.$/, "");
  return `${type} ${name.toLowerCase()} ${value}`;
};

export function createFakeCloudflare({
  onSecretSet,
}: { onSecretSet?: (name: string, text: string) => void } = {}) {
  const state: FakeState = {
    tokens: new Map(),
    accounts: new Map(),
    zones: new Map(),
    workerDomains: new Map(),
  };
  const failures: Failure[] = [];
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let echoToken = false;

  const ok = (result: unknown, info?: object) =>
    Response.json({
      success: true,
      errors: [],
      messages: [],
      result,
      ...(info ? { result_info: info } : {}),
    });
  const error = (status: number, code: number, message: string) =>
    Response.json(
      {
        success: false,
        errors: [{ code, message }],
        messages: [],
        result: null,
      },
      { status },
    );

  const notAllowed = () => error(403, 10000, "Authentication error");
  const noAccess = () =>
    error(403, 10000, "No access to the specified resource.");
  const canSeeWorkers = (token: FakeToken) =>
    token.permissions.includes("workers:read") ||
    token.permissions.includes("workers:write");

  function zoneJson(zone: FakeZone) {
    const account = state.accounts.get(zone.accountId);
    return {
      id: zone.id,
      name: zone.name,
      status: zone.status,
      account: { id: zone.accountId, name: account?.name ?? "" },
    };
  }

  type Handler = (context: {
    token: FakeToken;
    params: string[];
    body: Record<string, unknown>;
    url: URL;
  }) => Response;

  const needs =
    (
      permission: FakePermission | FakePermission[],
      handler: Handler,
    ): Handler =>
    (context) =>
      [permission]
        .flat()
        .some((name) => context.token.permissions.includes(name))
        ? handler(context)
        : notAllowed();

  const zoneRoute =
    (
      handler: (zone: FakeZone, context: Parameters<Handler>[0]) => Response,
    ): Handler =>
    (context) => {
      const zone = state.zones.get(context.params[0] ?? "");
      if (!zone || zone.accountId !== context.token.accountId)
        return error(404, 7003, "Zone not found");
      return handler(zone, context);
    };

  const workerRoute =
    (
      handler: (
        worker: FakeWorker,
        context: Parameters<Handler>[0],
        name: string,
      ) => Response,
    ): Handler =>
    (context) => {
      const [accountId = "", name = ""] = context.params;
      if (accountId !== context.token.accountId) return notAllowed();
      const worker = state.accounts.get(accountId)?.workers.get(name);
      return worker
        ? handler(worker, context, name)
        : error(404, 10007, "Worker not found");
    };

  const seesWorkers =
    (handler: Handler): Handler =>
    (context) =>
      canSeeWorkers(context.token) ? handler(context) : noAccess();

  const routes: [string, RegExp, Handler][] = [
    [
      "GET",
      /^\/zones$/,
      needs("zone:read", ({ token }) =>
        ok(
          [...state.zones.values()]
            .filter((zone) => zone.accountId === token.accountId)
            .map(zoneJson),
          { total_pages: 1 },
        ),
      ),
    ],
    [
      "GET",
      /^\/zones\/([^/]+)$/,
      needs(
        "zone:read",
        zoneRoute((zone) => ok(zoneJson(zone))),
      ),
    ],
    [
      "GET",
      /^\/accounts\/([^/]+)\/workers\/scripts$/,
      // Without Workers permission on the account, Cloudflare doesn't refuse this
      // list. It succeeds with nothing in it.
      ({ token, params }) => {
        if (params[0] !== token.accountId) return notAllowed();
        if (!canSeeWorkers(token)) return ok([]);
        const workers =
          state.accounts.get(token.accountId)?.workers ??
          new Map<string, FakeWorker>();
        return ok(
          [...workers].map(([id, worker]) => ({
            id,
            modified_on: worker.modifiedOn,
          })),
        );
      },
    ],
    [
      "GET",
      /^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/versions\/([^/]+)$/,
      seesWorkers(
        workerRoute((worker, { params }) =>
          worker.anyVersion || worker.versions.includes(params[2] ?? "")
            ? ok({ id: params[2] })
            : error(404, 10007, "Version not found"),
        ),
      ),
    ],
    [
      "GET",
      /^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/script-settings$/,
      seesWorkers(workerRoute((worker) => ok(worker.settings))),
    ],
    [
      "PATCH",
      /^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/script-settings$/,
      needs(
        "workers:write",
        workerRoute((worker, { body }) => {
          if (JSON.stringify(body).includes(":null"))
            return error(400, 10014, "Settings cannot be null");
          worker.settings = { ...worker.settings, ...body };
          return ok(worker.settings);
        }),
      ),
    ],
    [
      "GET",
      /^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/secrets$/,
      needs(
        ["workers:read", "workers:write"],
        workerRoute((worker) =>
          ok(
            [...worker.secrets].map((name) => ({ name, type: "secret_text" })),
          ),
        ),
      ),
    ],
    [
      "PUT",
      /^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/secrets$/,
      needs(
        "workers:write",
        workerRoute((worker, { body }) => {
          const name = String(body.name);
          worker.secrets.add(name);
          worker.versions.unshift(crypto.randomUUID());
          onSecretSet?.(name, String(body.text));
          return ok({ name, type: "secret_text" });
        }),
      ),
    ],
    [
      "GET",
      /^\/accounts\/([^/]+)\/workers\/domains$/,
      needs(["workers:read", "workers:write"], ({ token, params, url }) => {
        if (params[0] !== token.accountId) return notAllowed();
        const zoneId = url.searchParams.get("zone_id");
        return ok(
          (state.workerDomains.get(token.accountId) ?? []).filter(
            (domain) =>
              !zoneId ||
              (domain as WorkerDomain & { zone_id?: string }).zone_id ===
                zoneId,
          ),
        );
      }),
    ],
    [
      "PUT",
      /^\/accounts\/([^/]+)\/workers\/domains$/,
      needs("workers:write", ({ token, params, body }) => {
        if (params[0] !== token.accountId) return notAllowed();
        const domains = state.workerDomains.get(token.accountId) ?? [];
        const hostname = String(body.hostname);
        const zone = state.zones.get(String(body.zone_id));
        if (
          zone?.dns.some(
            (record) =>
              record.name === hostname &&
              ["A", "AAAA", "CNAME"].includes(record.type),
          )
        ) {
          return error(
            409,
            100117,
            "Hostname already has externally managed DNS records",
          );
        }
        const row = {
          hostname,
          service: String(body.service),
          zone_id: String(body.zone_id),
        };
        domains.push(row);
        state.workerDomains.set(token.accountId, domains);
        return ok(row);
      }),
    ],
    [
      "GET",
      /^\/zones\/([^/]+)\/dns_records$/,
      needs(
        ["dns:read", "dns:write"],
        zoneRoute((zone) => ok(zone.dns, { total_pages: 1 })),
      ),
    ],
    [
      "POST",
      /^\/zones\/([^/]+)\/dns_records$/,
      needs(
        "dns:write",
        zoneRoute((zone, { body }) => {
          const record = {
            type: String(body.type),
            name: String(body.name),
            content: String(body.content),
            ...(typeof body.priority === "number"
              ? { priority: body.priority }
              : {}),
          };
          if (
            zone.dns.some((other) => identityOf(other) === identityOf(record))
          ) {
            return error(400, 81058, "An identical record already exists.");
          }
          zone.dns.push(record);
          return ok(record);
        }),
      ),
    ],
    [
      "GET",
      /^\/zones\/([^/]+)\/email\/routing$/,
      needs(
        "zone-settings:write",
        zoneRoute((zone) => ok(zone.routing)),
      ),
    ],
    [
      "POST",
      /^\/zones\/([^/]+)\/email\/routing\/dns$/,
      needs(
        "zone-settings:write",
        zoneRoute((zone) => {
          if (
            zone.dns.some(
              (record) =>
                record.type === "MX" &&
                record.name === zone.name &&
                !record.content.endsWith(".mx.cloudflare.net"),
            )
          ) {
            return error(400, 2008, "Non-Cloudflare MX records exist");
          }
          zone.routing = { enabled: true, status: "ready" };
          zone.dns.push({
            type: "MX",
            name: zone.name,
            content: "route1.mx.cloudflare.net",
            priority: 10,
          });
          return ok(zone.routing);
        }),
      ),
    ],
    [
      "GET",
      /^\/zones\/([^/]+)\/email\/routing\/rules\/catch_all$/,
      needs(
        "routing-rules:write",
        zoneRoute((zone) => ok(zone.catchAll)),
      ),
    ],
    [
      "PUT",
      /^\/zones\/([^/]+)\/email\/routing\/rules\/catch_all$/,
      needs(
        "routing-rules:write",
        zoneRoute((zone, { body }) => {
          zone.catchAll = {
            enabled: body.enabled === true,
            actions: body.actions as FakeZone["catchAll"]["actions"],
          };
          return ok(zone.catchAll);
        }),
      ),
    ],
    [
      "GET",
      /^\/zones\/([^/]+)\/email\/sending\/subdomains$/,
      needs(
        "sending:write",
        zoneRoute((zone) => ok(zone.sending, { total_pages: 1 })),
      ),
    ],
    [
      "POST",
      /^\/zones\/([^/]+)\/email\/sending\/subdomains$/,
      needs(
        "sending:write",
        zoneRoute((zone, { body }) => {
          const name = String(body.name);
          let row = zone.sending.find((item) => item.name === name);
          if (row) row.enabled = true;
          else {
            row = {
              tag: crypto.randomUUID().replaceAll("-", ""),
              name,
              enabled: true,
            };
            zone.sending.push(row);
            // The live API adds these itself. What it does when the zone already
            // has a DMARC or SPF record wasn't seen, so this leaves those alone.
            for (const record of SENDING_RECORDS(name)) {
              const taken = zone.dns.some(
                (other) =>
                  other.type === record.type &&
                  other.name === record.name &&
                  POLICY.test(other.content) &&
                  POLICY.test(record.content),
              );
              if (!taken) zone.dns.push(storedForm(record));
            }
          }
          return ok(row);
        }),
      ),
    ],
    [
      "GET",
      /^\/zones\/([^/]+)\/email\/sending\/subdomains\/([^/]+)\/dns$/,
      needs(
        "sending:write",
        zoneRoute((zone, { params }) => {
          const row = zone.sending.find((item) => item.tag === params[1]);
          return row
            ? ok(SENDING_RECORDS(row.name))
            : error(404, 1000, "Not found");
        }),
      ),
    ],
  ];

  async function handle(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/client\/v4/, "");
    const body =
      request.method === "GET"
        ? {}
        : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
    calls.push({
      method: request.method,
      path: `${path}${url.search}`,
      ...(request.method === "GET" ? {} : { body }),
    });

    const header = request.headers.get("authorization") ?? "";
    const tokenValue = header.replace(/^Bearer /, "");
    const failing = failures.findIndex(
      (item) => item.method === request.method && item.path.test(path),
    );
    const failure = failures[failing];
    if (failure && failure.skip) failure.skip--;
    else if (failure) {
      failures.splice(failing, 1);
      return error(failure.status, failure.code ?? 1000, failure.message);
    }

    const token = state.tokens.get(tokenValue);
    if (!token) {
      return error(
        401,
        10000,
        echoToken ? `Invalid token ${tokenValue}` : "Invalid request headers",
      );
    }

    for (const [method, pattern, handler] of routes) {
      if (method !== request.method) continue;
      const match = pattern.exec(path);
      if (!match) continue;
      const response = handler({
        token,
        params: match.slice(1).map(decodeURIComponent),
        body,
        url,
      });
      if (echoToken && !response.ok) {
        return error(response.status, 1000, `Refused for ${tokenValue}`);
      }
      return response;
    }
    return error(404, 7000, `No route for ${request.method} ${path}`);
  }

  return {
    state,
    calls,
    fetch: handle,
    failOnce: (failure: Failure) => failures.push(failure),
    echoTokenInErrors: () => {
      echoToken = true;
    },
    addAccount(accountId: string, name: string) {
      state.accounts.set(accountId, { name, workers: new Map() });
    },
    addWorker(
      accountId: string,
      name: string,
      versions: string[] | "any",
      modifiedOn = "2026-01-01T00:00:00Z",
    ) {
      state.accounts.get(accountId)?.workers.set(name, {
        versions: versions === "any" ? [] : versions,
        anyVersion: versions === "any",
        secrets: new Set(),
        modifiedOn,
        // A new Worker's settings, as the live API returned them.
        settings: {
          logpush: false,
          tags: null,
          tail_consumers: null,
          observability: null,
        },
      });
    },
    addZone(
      accountId: string,
      id: string,
      name: string,
      dns: DnsRecord[] = [],
    ) {
      state.zones.set(id, {
        id,
        name,
        accountId,
        status: "active",
        dns,
        routing: { enabled: false, status: "unconfigured" },
        catchAll: { enabled: false, actions: [{ type: "drop" }] },
        sending: [],
      });
    },
    addToken(
      token: string,
      accountId: string,
      permissions: readonly FakePermission[] = ALL_PERMISSIONS,
    ) {
      state.tokens.set(token, { accountId, permissions });
    },
    writes: () =>
      calls.filter(
        (call) =>
          call.method !== "GET" && !call.path.endsWith("/script-settings"),
      ),
  };
}
