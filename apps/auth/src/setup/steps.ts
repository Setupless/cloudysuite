import { APPS } from "../../../../src/routing";
import {
  type CatchAll,
  type Cloudflare,
  CloudflareError,
  type DnsRecord,
  type Zone,
} from "./cloudflare";
import type {
  DomainChoice,
  DomainPlan,
  ManualGuide,
  StepId,
  StepMode,
  StepResult,
} from "./model";
import { bare, externalMxHosts, fullName } from "./scan";

export const AUTH_SECRET_NAME = "BETTER_AUTH_SECRET";

export type StepContext = {
  api: Cloudflare;
  accountId: string;
  scriptName: string;
  plan: DomainPlan;
  // Whether this running copy of the Worker can already see the secret.
  secretVisible: boolean;
};

type CheckResult = Exclude<StepResult, { state: "failed" }> & {
  action?: string;
};

export type SetupStep = {
  id: StepId;
  check(context: StepContext): Promise<CheckResult>;
  apply(context: StepContext): Promise<void>;
  guide(context: StepContext): ManualGuide;
  // Named when Cloudflare refuses the step, in the words of its token form.
  permission: string;
};

const dashboard = (path: string) =>
  `https://dash.cloudflare.com/?to=/:account/${path}`;
const DOCS = {
  routing:
    "https://developers.cloudflare.com/email-service/configuration/domains/",
  plans: "https://developers.cloudflare.com/workers/platform/pricing/",
  domains:
    "https://developers.cloudflare.com/workers/configuration/routing/custom-domains/",
  secrets: "https://developers.cloudflare.com/workers/configuration/secrets/",
  tokens:
    "https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/",
};

export function planDomains(zone: Zone, choice: DomainChoice): DomainPlan {
  return {
    zoneId: zone.id,
    zoneName: zone.name,
    emailDomain: zone.name,
    appDomain: choice.appLabel ? `${choice.appLabel}.${zone.name}` : zone.name,
  };
}

export function appHostnames(appDomain: string): string[] {
  return Object.keys(APPS).map((app) => `${app}.${appDomain}`);
}

const QUOTED_STRINGS = /^"(?:[^"\\]|\\.)*"(?:\s*"(?:[^"\\]|\\.)*")*$/;

// DNS joins a TXT record's quoted strings with nothing between them, so a long
// DKIM key can be split anywhere and still be the same key.
function txtValue(content: string) {
  const text = content.trim();
  if (!QUOTED_STRINGS.test(text)) return text;
  return (text.match(/"(?:[^"\\]|\\.)*"/g) ?? [])
    .map((part) => part.slice(1, -1).replace(/\\(.)/g, "$1"))
    .join("");
}

const sameContent = (type: string, a: string, b: string) =>
  type === "TXT" ? txtValue(a) === txtValue(b) : bare(a) === bare(b);

function isPolicy(content: string, prefix: "v=dmarc1" | "v=spf1") {
  return txtValue(content).toLowerCase().startsWith(prefix);
}

const spfTerms = (content: string) =>
  txtValue(content)
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "v=spf1" && !/^[-~?+]?all$/.test(term));

// A merged record keeps its own terms as well as the ones Cloudflare needs.
function spfCovers(existing: string, expected: string) {
  const terms = spfTerms(existing);
  return spfTerms(expected).every((term) => terms.includes(term));
}

// A domain may already publish DMARC, and that stays. It may also publish SPF,
// and a second SPF record would break mail, so only a person can merge it.
function sendingDnsGaps(
  expected: DnsRecord[],
  existing: DnsRecord[],
  zoneName: string,
) {
  const creatable: DnsRecord[] = [];
  const conflicts: DnsRecord[] = [];
  for (const record of expected) {
    const name = fullName(record.name, zoneName);
    const sameName = existing.filter(
      (other) =>
        other.type === record.type && fullName(other.name, zoneName) === name,
    );
    if (
      sameName.some((other) =>
        sameContent(record.type, other.content, record.content),
      )
    )
      continue;
    if (record.type === "TXT" && isPolicy(record.content, "v=dmarc1")) {
      if (sameName.some((other) => isPolicy(other.content, "v=dmarc1")))
        continue;
    }
    if (
      record.type === "TXT" &&
      isPolicy(record.content, "v=spf1") &&
      sameName.some((other) => isPolicy(other.content, "v=spf1"))
    ) {
      const merged = sameName.some(
        (other) =>
          isPolicy(other.content, "v=spf1") &&
          spfCovers(other.content, record.content),
      );
      if (!merged) conflicts.push(record);
      continue;
    }
    creatable.push({ ...record, name });
  }
  return { creatable, conflicts };
}

// The live API gave this message. Other tools report it with this code, but
// Cloudflare's docs don't list it, so either one counts.
const isIdenticalRecord = (error: unknown) =>
  error instanceof CloudflareError &&
  (error.code === 81058 || /identical record/i.test(error.message));

const describeRecord = (record: DnsRecord, zoneName: string) =>
  `${record.type} ${fullName(record.name, zoneName)} ${record.content}`;

function catchAllGuide({ plan, scriptName }: StepContext): ManualGuide {
  return {
    action: `In Cloudflare, open Email Routing for ${plan.emailDomain}, then Routing rules. Set the catch-all address to "Send to a Worker" and pick ${scriptName}. Then check again.`,
    dashboardUrl: dashboard("email-service/routing"),
    docsUrl: DOCS.routing,
  };
}

function describeAction(action: CatchAll["actions"][number]) {
  const { type, value = [] } = action;
  const targets = value.join(" and ");
  if (type === "forward") return `is forwarded to ${targets}`;
  if (type === "worker") return `goes to another Worker, ${targets}`;
  if (type === "drop") return "is deleted";
  // The person confirms this exact sentence, so two different rules must not
  // read the same.
  return `is handled by a rule CloudySuite doesn't recognise: ${JSON.stringify(action)}`;
}

function describeCatchAll(rule: CatchAll, emailDomain: string) {
  const handling =
    rule.actions.length > 0
      ? rule.actions.map(describeAction).join(" and ")
      : "is handled by a rule with no action";
  return `Right now, mail to any address at ${emailDomain} that has no rule of its own ${handling}.`;
}

const SENDING_RECORDS_NOTICE =
  "Cloudflare adds the DNS records this needs to your domain. One is a DMARC record, which tells other mail systems to refuse mail that claims to be from your domain but can't prove it. If a newsletter tool or another service sends mail as your domain, check that it signs its mail. CloudySuite doesn't change a DMARC record you already have.";

export const SETUP_STEPS: readonly SetupStep[] = [
  {
    id: "email-routing",
    permission: "Zone Settings: Edit, set to your domain",
    async check({ api, plan }) {
      const routing = await api.getEmailRouting(plan.zoneId);
      if (routing.enabled && (routing.status ?? "ready") === "ready") {
        return {
          state: "done",
          detail: `Mail to ${plan.emailDomain} now reaches Cloudflare.`,
        };
      }
      const external = externalMxHosts(
        await api.listDnsRecords(plan.zoneId),
        plan.zoneName,
      );
      if (external.length > 0) {
        return {
          state: "needs-action",
          guide: {
            action: `Mail for ${plan.emailDomain} currently goes to ${external.join(", ")}. Cloudflare can't take over until those MX records are gone. If you still use that mail provider, stop here and move your mail first. Otherwise, delete those MX records, then check again.`,
            dashboardUrl: dashboard(":zone/dns/records"),
            docsUrl: DOCS.routing,
          },
        };
      }
      return {
        state: "missing",
        detail: "Email Routing is off for this domain.",
      };
    },
    apply: ({ api, plan }) => api.enableEmailRouting(plan.zoneId),
    guide: ({ plan }) => ({
      action: `In Cloudflare, open Email Routing, select ${plan.emailDomain}, and turn it on. Then check again.`,
      dashboardUrl: dashboard("email-service/routing"),
      docsUrl: DOCS.routing,
    }),
  },
  {
    id: "email-sending",
    permission:
      "Email Sending: Edit, set to the account, and DNS: Edit, set to your domain",
    async check({ api, plan }) {
      const domains = await api.listSendingDomains(plan.zoneId);
      const row = domains.find(
        (domain) => domain.name === plan.emailDomain && domain.enabled,
      );
      if (!row)
        return {
          state: "missing",
          detail: `Sending isn't on for this domain. ${SENDING_RECORDS_NOTICE}`,
        };

      const [expected, existing] = await Promise.all([
        api.expectedSendingDns(plan.zoneId, row.tag),
        api.listDnsRecords(plan.zoneId),
      ]);
      const { creatable, conflicts } = sendingDnsGaps(
        expected,
        existing,
        plan.zoneName,
      );
      const gaps = [...creatable, ...conflicts];
      if (gaps.length === 0) {
        return {
          state: "done",
          detail: `${plan.emailDomain} can send mail. ${SENDING_RECORDS_NOTICE}`,
        };
      }
      return {
        state: "missing",
        detail: "Some sending DNS records are missing.",
        action: `Add these DNS records to ${plan.zoneName}, merging any SPF record you already have: ${gaps
          .map((record) => describeRecord(record, plan.zoneName))
          .join("; ")}. Then check again.`,
      };
    },
    async apply({ api, plan }) {
      const domains = await api.listSendingDomains(plan.zoneId);
      let row = domains.find((domain) => domain.name === plan.emailDomain);
      if (!row?.enabled) {
        await api.addSendingDomain(plan.zoneId, plan.emailDomain);
        const refreshed = await api.listSendingDomains(plan.zoneId);
        row = refreshed.find((domain) => domain.name === plan.emailDomain);
        if (!row) return;
      }
      const [expected, existing] = await Promise.all([
        api.expectedSendingDns(plan.zoneId, row.tag),
        api.listDnsRecords(plan.zoneId),
      ]);
      const { creatable } = sendingDnsGaps(expected, existing, plan.zoneName);
      // Adding a sending domain makes Cloudflare add these records itself, so
      // one can appear after the list above was read. The check that follows
      // this decides the result.
      for (const record of creatable) {
        try {
          await api.createDnsRecord(plan.zoneId, record);
        } catch (error) {
          if (!isIdenticalRecord(error)) throw error;
        }
      }
    },
    guide: ({ plan }) => ({
      action: `In Cloudflare, open Email Sending, choose Onboard Domain, and pick ${plan.emailDomain}. Sending needs the Workers Paid plan. Then check again.`,
      dashboardUrl: dashboard("email-service/sending"),
      docsUrl: DOCS.plans,
    }),
  },
  {
    id: "catch-all",
    permission:
      "Email Routing Rules: Edit, set to your domain. Email Routing Account Rules is a different permission",
    async check(context) {
      const { api, plan, scriptName } = context;
      const rule = await api.getCatchAll(plan.zoneId);
      if (!rule) {
        const guide = catchAllGuide(context);
        return {
          state: "needs-action",
          guide: {
            ...guide,
            action: `Cloudflare didn't tell us what your catch-all rule does now, so we left it alone. ${guide.action}`,
          },
        };
      }
      if (!rule.enabled) {
        return {
          state: "missing",
          detail: "Incoming mail doesn't reach CloudySuite yet.",
        };
      }
      const worker = rule.actions.find((action) => action.type === "worker");
      if (worker?.value?.[0] === scriptName) {
        return {
          state: "done",
          detail: `Mail to any address at ${plan.emailDomain} reaches CloudySuite.`,
        };
      }
      return {
        state: "needs-confirmation",
        current: describeCatchAll(rule, plan.emailDomain),
      };
    },
    apply: ({ api, plan, scriptName }) =>
      api.setCatchAllToWorker(plan.zoneId, scriptName),
    guide: catchAllGuide,
  },
  {
    id: "app-hostnames",
    permission: "Workers Scripts: Edit, set to the account",
    async check({ api, accountId, scriptName, plan }) {
      const attached = await api.listWorkerDomains(accountId, plan.zoneId);
      const hosts = appHostnames(plan.appDomain);
      const otherWorker = attached.find(
        (domain) =>
          hosts.includes(domain.hostname) && domain.service !== scriptName,
      );
      if (otherWorker) {
        return {
          state: "needs-action",
          guide: {
            action: `${otherWorker.hostname} is attached to another Worker, ${otherWorker.service}. Remove it from that Worker, then check again.`,
            dashboardUrl: dashboard(
              `workers/services/view/${otherWorker.service}/production/settings`,
            ),
            docsUrl: DOCS.domains,
          },
        };
      }
      const missing = hosts.filter(
        (host) => !attached.some((domain) => domain.hostname === host),
      );
      if (missing.length === 0) {
        return {
          state: "done",
          detail: `${hosts.join(" and ")} point to CloudySuite.`,
        };
      }
      const records = await api.listDnsRecords(plan.zoneId);
      const blocked = missing.filter((host) =>
        records.some(
          (record) =>
            ["A", "AAAA", "CNAME"].includes(record.type) &&
            fullName(record.name, plan.zoneName) === host,
        ),
      );
      if (blocked.length > 0) {
        return {
          state: "needs-action",
          guide: {
            action: `Something else already uses ${blocked.join(" and ")}, and CloudySuite needs ${blocked.length > 1 ? "those addresses" : "that address"}. Delete the DNS records for ${blocked.length > 1 ? "them" : "it"}, or reload this page and choose a different address for your apps. Then check again.`,
            dashboardUrl: dashboard(":zone/dns/records"),
            docsUrl: DOCS.domains,
          },
        };
      }
      return {
        state: "missing",
        detail: `${missing.join(" and ")} aren't attached yet.`,
      };
    },
    async apply({ api, accountId, scriptName, plan }) {
      const attached = await api.listWorkerDomains(accountId, plan.zoneId);
      for (const hostname of appHostnames(plan.appDomain)) {
        if (attached.some((domain) => domain.hostname === hostname)) continue;
        await api.attachWorkerDomain(accountId, {
          hostname,
          service: scriptName,
          zone_id: plan.zoneId,
        });
      }
    },
    guide: ({ plan, scriptName }) => ({
      action: `In Cloudflare, open the ${scriptName} Worker, then Settings, then Domains & Routes. Add ${appHostnames(plan.appDomain).join(" and ")} as custom domains. Then check again.`,
      dashboardUrl: dashboard(
        `workers/services/view/${scriptName}/production/settings`,
      ),
      docsUrl: DOCS.domains,
    }),
  },
  {
    id: "auth-secret",
    permission: "Workers Scripts: Edit, set to the account",
    async check({ api, accountId, scriptName, secretVisible }) {
      if (secretVisible)
        return { state: "done", detail: "Sign-in has its secret key." };
      const names = await api.listSecretNames(accountId, scriptName);
      if (!names.includes(AUTH_SECRET_NAME)) {
        return { state: "missing", detail: "Sign-in has no secret key yet." };
      }
      return {
        state: "needs-action",
        retry: true,
        guide: {
          action:
            "Cloudflare is still restarting CloudySuite with its new secret key. This usually takes a few seconds.",
          dashboardUrl: dashboard(
            `workers/services/view/${scriptName}/production/settings`,
          ),
          docsUrl: DOCS.secrets,
        },
      };
    },
    // The check above runs first, so an existing secret is never replaced.
    apply: ({ api, accountId, scriptName }) => {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const secret = btoa(String.fromCharCode(...bytes));
      return api.putSecret(accountId, scriptName, AUTH_SECRET_NAME, secret);
    },
    guide: ({ scriptName }) => ({
      action: `In Cloudflare, open the ${scriptName} Worker, then Settings, then Variables and Secrets. Add a secret named ${AUTH_SECRET_NAME} with a long random value. Then check again.`,
      dashboardUrl: dashboard(
        `workers/services/view/${scriptName}/production/settings`,
      ),
      docsUrl: DOCS.secrets,
    }),
  },
];

function outcomeOfError(
  error: unknown,
  guide: ManualGuide,
  permission: string,
): StepResult {
  if (!(error instanceof CloudflareError)) throw error;
  if (
    error.denied ||
    error.code === 10000 ||
    /authentication error/i.test(error.message)
  ) {
    return {
      state: "needs-action",
      guide: {
        action: `Your token isn't allowed to do this step. It needs ${permission}. Create the token again from the link on the first page, keep every permission it fills in, and start again. If you'd rather do this step yourself: ${guide.action}`,
        dashboardUrl: guide.dashboardUrl,
        docsUrl: DOCS.tokens,
      },
    };
  }
  return { state: "failed", message: `Cloudflare said: ${error.message}` };
}

const asResult = ({ action: _action, ...result }: CheckResult): StepResult =>
  result;

// Check, apply only the difference, then check again. The second check decides
// the result, so a change that Cloudflare accepted but did not make shows up
// as a job for the person, not as success.
export async function runStep(
  step: SetupStep,
  context: StepContext,
  mode: StepMode,
  confirmReplace?: string,
): Promise<StepResult> {
  const guide = step.guide(context);
  try {
    const before = await step.check(context);
    // The wording must still match, so a rule that changed after the person
    // looked at it is shown to them again instead of being replaced unseen.
    const confirmed =
      before.state === "needs-confirmation" &&
      before.current === confirmReplace;
    if (mode === "check" || (before.state !== "missing" && !confirmed))
      return asResult(before);

    await step.apply(context);

    const after = await step.check(context);
    if (after.state !== "missing" && after.state !== "needs-confirmation")
      return asResult(after);
    return {
      state: "needs-action",
      guide: { ...guide, action: after.action ?? guide.action },
    };
  } catch (error) {
    return outcomeOfError(error, guide, step.permission);
  }
}
