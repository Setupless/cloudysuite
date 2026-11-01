export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Local runs point this at a fake server through `.dev.vars`. A request cannot
// change env, and a Worker on Cloudflare cannot reach a loopback address, so
// this cannot send a pasted token anywhere else.
export function cloudflareApiBase(override: string | undefined): string {
  const url = override ? URL.parse(override) : null;
  return url && LOOPBACK.has(url.hostname)
    ? url.href.replace(/\/$/, "")
    : CLOUDFLARE_API;
}

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export type Zone = {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
};

export type WorkerScript = { id: string; modified_on?: string };

export type DnsRecord = {
  type: string;
  name: string;
  content: string;
  priority?: number;
};

export type EmailRouting = { enabled: boolean; status?: string };

export type CatchAll = {
  enabled: boolean;
  actions: { type: string; value?: string[] }[];
};

export type SendingDomain = { tag: string; name: string; enabled: boolean };

export type WorkerDomain = { hostname: string; service: string };

type ScriptSettings = {
  logpush?: unknown;
  observability?: unknown;
  tags?: unknown;
  tail_consumers?: unknown;
};

export class CloudflareError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "CloudflareError";
  }

  get denied(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

type Envelope<Result> = {
  success?: boolean;
  result?: Result;
  errors?: { code?: number; message?: string }[];
  result_info?: { total_pages?: number };
};

const MAX_PAGES = 20;

const noResult = () =>
  new CloudflareError(502, null, "Cloudflare sent back an empty answer.");

// Cloudflare reads unset settings back as null, and its reference lists no null
// for a patch.
const withoutNulls = (settings: ScriptSettings): ScriptSettings =>
  JSON.parse(
    JSON.stringify(settings, (_key, value) =>
      value === null ? undefined : value,
    ),
  );

export type Cloudflare = ReturnType<typeof createCloudflare>;

export function createCloudflare({
  token,
  baseUrl,
  fetch: send,
}: {
  token: string;
  baseUrl: string;
  fetch: HttpFetch;
}) {
  // Cloudflare's message reaches the person's screen, so it must not repeat the token.
  const scrub = (text: string) => text.replaceAll(token, "[token hidden]");

  async function call<Result>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Envelope<Result>> {
    let response: Response;
    try {
      response = await send(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CloudflareError(0, null, "We couldn't reach Cloudflare.");
    }
    const envelope = (await response
      .json()
      .catch(() => ({}))) as Envelope<Result>;
    // Anything less than an explicit success must not count as proof.
    if (response.ok && envelope.success === true) return envelope;
    const first = envelope.errors?.[0];
    throw new CloudflareError(
      response.status,
      first?.code ?? null,
      scrub(
        first?.message ?? `Cloudflare answered with status ${response.status}.`,
      ).slice(0, 300),
    );
  }

  async function result<Result>(method: string, path: string, body?: unknown) {
    return (await call<Result>(method, path, body)).result as Result;
  }

  async function allPages<Item>(
    path: string,
    perPage: number,
  ): Promise<Item[]> {
    const items: Item[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= MAX_PAGES; page++) {
      const envelope = await call<Item[]>(
        "GET",
        `${path}${separator}page=${page}&per_page=${perPage}`,
      );
      items.push(...(envelope.result ?? []));
      if (page >= (envelope.result_info?.total_pages ?? 1)) break;
    }
    return items;
  }

  const script = (accountId: string, name: string) =>
    `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}`;
  const zonePath = (zoneId: string) => `/zones/${encodeURIComponent(zoneId)}`;

  return {
    listZones: () => allPages<Zone>("/zones", 50),
    getZone: (zoneId: string) => result<Zone>("GET", zonePath(zoneId)),

    listScripts: async (accountId: string) =>
      (await result<WorkerScript[] | null>(
        "GET",
        `/accounts/${encodeURIComponent(accountId)}/workers/scripts`,
      )) ?? [],

    // A version id is one Cloudflare generates, so only the account that owns
    // this Worker can have it. The version tag is set by the uploader, so it proves nothing.
    async hasVersion(accountId: string, name: string, versionId: string) {
      try {
        const version = await result<{ id?: string } | null>(
          "GET",
          `${script(accountId, name)}/versions/${encodeURIComponent(versionId)}`,
        );
        return version?.id === versionId;
      } catch (error) {
        if (error instanceof CloudflareError && error.status === 404)
          return false;
        throw error;
      }
    },

    // Writing back what Cloudflare just returned changes nothing, and these are
    // not versioned settings, so it adds no version. Only a token that can edit
    // this Worker gets a success. Cloudflare's reference doesn't say what a patch
    // does to a field it leaves out, so this sends each one that has a value.
    // Returns false, having written nothing, when there is no value to send.
    async rewriteScriptSettings(accountId: string, name: string) {
      const path = `${script(accountId, name)}/script-settings`;
      const current = await result<ScriptSettings | null>("GET", path);
      const { logpush, observability, tags, tail_consumers } = current ?? {};
      const settings = withoutNulls({
        logpush,
        observability,
        tags,
        tail_consumers,
      });
      if (Object.keys(settings).length === 0) return false;
      const written = await result<ScriptSettings | null>(
        "PATCH",
        path,
        settings,
      );
      if (!written) throw noResult();
      return true;
    },

    listSecretNames: async (accountId: string, name: string) =>
      (
        (await result<{ name: string }[] | null>(
          "GET",
          `${script(accountId, name)}/secrets`,
        )) ?? []
      ).map((secret) => secret.name),
    async putSecret(
      accountId: string,
      name: string,
      secret: string,
      text: string,
    ) {
      await call("PUT", `${script(accountId, name)}/secrets`, {
        name: secret,
        text,
        type: "secret_text",
      });
    },

    listDnsRecords: (zoneId: string) =>
      allPages<DnsRecord>(`${zonePath(zoneId)}/dns_records`, 500),
    async createDnsRecord(zoneId: string, record: DnsRecord) {
      await call("POST", `${zonePath(zoneId)}/dns_records`, {
        ...record,
        ttl: 1,
      });
    },

    getEmailRouting: (zoneId: string) =>
      result<EmailRouting>("GET", `${zonePath(zoneId)}/email/routing`),
    async enableEmailRouting(zoneId: string) {
      await call("POST", `${zonePath(zoneId)}/email/routing/dns`, {});
    },

    // Null means Cloudflare didn't say, which is not the same as having no rule.
    async getCatchAll(zoneId: string): Promise<CatchAll | null> {
      const rule = await result<Partial<CatchAll> | null>(
        "GET",
        `${zonePath(zoneId)}/email/routing/rules/catch_all`,
      );
      return typeof rule?.enabled === "boolean"
        ? { enabled: rule.enabled, actions: rule.actions ?? [] }
        : null;
    },
    async setCatchAllToWorker(zoneId: string, name: string) {
      await call("PUT", `${zonePath(zoneId)}/email/routing/rules/catch_all`, {
        actions: [{ type: "worker", value: [name] }],
        matchers: [{ type: "all" }],
        enabled: true,
      });
    },

    listSendingDomains: (zoneId: string) =>
      allPages<SendingDomain>(
        `${zonePath(zoneId)}/email/sending/subdomains`,
        50,
      ),
    async addSendingDomain(zoneId: string, name: string) {
      await call("POST", `${zonePath(zoneId)}/email/sending/subdomains`, {
        name,
      });
    },
    expectedSendingDns: async (zoneId: string, tag: string) =>
      (await result<DnsRecord[] | null>(
        "GET",
        `${zonePath(zoneId)}/email/sending/subdomains/${encodeURIComponent(tag)}/dns`,
      )) ?? [],

    listWorkerDomains: async (accountId: string, zoneId: string) =>
      (await result<WorkerDomain[] | null>(
        "GET",
        `/accounts/${encodeURIComponent(accountId)}/workers/domains?zone_id=${encodeURIComponent(zoneId)}`,
      )) ?? [],
    async attachWorkerDomain(
      accountId: string,
      domain: { hostname: string; service: string; zone_id: string },
    ) {
      await call(
        "PUT",
        `/accounts/${encodeURIComponent(accountId)}/workers/domains`,
        domain,
      );
    },
  };
}
