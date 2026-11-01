import { readSettings } from "../../../../src/settings";
import { createAuth } from "../auth";
import { appOrigins } from "../origins";
import { claimError, claimWorker, isTokenShaped, proveClaim } from "./claim";
import {
  type Cloudflare,
  CloudflareError,
  createCloudflare,
  type HttpFetch,
} from "./cloudflare";
import { createFirstAdmin } from "./first-admin";
import type {
  ClaimResponse,
  DomainChoice,
  FinishResponse,
  ScanResponse,
  SetupError,
  SetupRequest,
  StepResponse,
  StepResult,
} from "./model";
import { scanZone } from "./scan";
import { planDomains, runStep, SETUP_STEPS, type StepContext } from "./steps";
import { parseSetupRequest } from "./validate";

export type SetupDependencies = {
  database: D1Database;
  // The id of the version running right now. It changes when a secret is set.
  versionId: string;
  // BETTER_AUTH_SECRET as this running copy of the Worker sees it.
  secret: string | undefined;
  apiBase: string;
  fetch: HttpFetch;
};

const STATUS: Record<SetupError["code"], number> = {
  "bad-request": 400,
  "claim-failed": 403,
  "already-finished": 409,
  "steps-unfinished": 409,
  cloudflare: 502,
  unexpected: 500,
};

class SetupFailure extends Error {
  constructor(readonly detail: SetupError) {
    super(detail.code);
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const failure = (error: SetupError) =>
  json(STATUS[error.code], { ok: false, error });

const success = <Body>(body: Body) => json(200, { ok: true, ...body });

const BAD_REQUEST: SetupError = {
  code: "bad-request",
  message:
    "Something in that request wasn't right. Reload this page and try again.",
};

const ALREADY_FINISHED: SetupError = {
  code: "already-finished",
  message:
    "Setup has already been finished, so nothing changed. If you don't have an account yet, ask the person who finished setup to invite you.",
};

// Until the claim is proven the caller may be anyone, and Cloudflare's text can
// describe this Worker, so it stays out of the response.
async function beforeProof<Result>(work: () => Promise<Result>) {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof CloudflareError)) throw error;
    throw new SetupFailure({
      code: "cloudflare",
      message:
        "We couldn't check your token with Cloudflare just now. Wait a moment and try again.",
    });
  }
}

async function claim(
  token: string,
  deps: SetupDependencies,
): Promise<ClaimResponse> {
  const outcome = await beforeProof(() =>
    claimWorker(client(token, deps), deps.versionId),
  );
  if (!outcome.ok) throw new SetupFailure(claimError(outcome.reason));
  return {
    worker: outcome.worker,
    zones: outcome.zones.map(({ id, name, status }) => ({
      id,
      name,
      active: status === "active",
    })),
  };
}

const client = (token: string, deps: SetupDependencies) =>
  createCloudflare({ token, baseUrl: deps.apiBase, fetch: deps.fetch });

async function proven(
  request: Exclude<SetupRequest, { action: "claim" }>,
  deps: SetupDependencies,
): Promise<Cloudflare> {
  const api = client(request.claim.token, deps);
  const reason = await beforeProof(() =>
    proveClaim(api, deps.versionId, request.claim),
  );
  if (reason) throw new SetupFailure(claimError(reason));
  return api;
}

async function zoneInAccount(
  api: Cloudflare,
  zoneId: string,
  accountId: string,
) {
  const zone = await api.getZone(zoneId);
  if (zone.account.id !== accountId) throw new SetupFailure(BAD_REQUEST);
  return zone;
}

async function contextFor(
  api: Cloudflare,
  request: {
    claim: { accountId: string; scriptName: string };
    choice: DomainChoice;
  },
  deps: SetupDependencies,
): Promise<StepContext> {
  const zone = await zoneInAccount(
    api,
    request.choice.zoneId,
    request.claim.accountId,
  );
  return {
    api,
    accountId: request.claim.accountId,
    scriptName: request.claim.scriptName,
    plan: planDomains(zone, request.choice),
    secretVisible: Boolean(deps.secret),
  };
}

async function scan(
  request: Extract<SetupRequest, { action: "scan" }>,
  deps: SetupDependencies,
): Promise<ScanResponse> {
  const api = await proven(request, deps);
  const zone = await zoneInAccount(
    api,
    request.zoneId,
    request.claim.accountId,
  );
  const [records, attached] = await Promise.all([
    api.listDnsRecords(zone.id),
    api.listWorkerDomains(request.claim.accountId, zone.id),
  ]);
  const own = attached.filter(
    (domain) => domain.service === request.claim.scriptName,
  );
  // A reloaded wizard lost its choice, so read it back from what it attached.
  const resumed = own.find((domain) => domain.hostname.startsWith("auth."));
  const resumedDomain = resumed?.hostname.slice("auth.".length);
  const resumedLabel = resumedDomain
    ? resumedDomain === zone.name
      ? null
      : resumedDomain.slice(0, -(zone.name.length + 1))
    : undefined;
  return {
    scan: scanZone(
      zone.name,
      records,
      attached,
      request.claim.scriptName,
      resumedLabel,
    ),
  };
}

async function step(
  request: Extract<SetupRequest, { action: "step" }>,
  deps: SetupDependencies,
): Promise<StepResponse> {
  const api = await proven(request, deps);
  const context = await contextFor(api, request, deps);
  const definition = SETUP_STEPS.find(({ id }) => id === request.stepId);
  if (!definition) throw new SetupFailure(BAD_REQUEST);
  return {
    result: await runStep(
      definition,
      context,
      request.mode,
      request.confirmReplace,
    ),
    plan: context.plan,
  };
}

const isDone = (result: StepResult) => result.state === "done";

async function finish(
  request: Extract<SetupRequest, { action: "finish" }>,
  http: Request,
  deps: SetupDependencies,
): Promise<FinishResponse> {
  const api = await proven(request, deps);
  const context = await contextFor(api, request, deps);
  const results = await Promise.all(
    SETUP_STEPS.map((definition) => runStep(definition, context, "check")),
  );
  if (!results.every(isDone) || !deps.secret) {
    throw new SetupFailure({
      code: "steps-unfinished",
      message:
        "Cloudflare no longer shows every step as finished. Go back and check them again.",
    });
  }

  const { plan } = context;
  const origins = appOrigins(plan.appDomain, http);
  const created = await createFirstAdmin({
    database: deps.database,
    auth: createAuth({
      database: deps.database,
      secret: deps.secret,
      primaryDomain: plan.appDomain,
      origins,
    }),
    plan,
    admin: request.admin,
  });
  if (!created) throw new SetupFailure(ALREADY_FINISHED);
  return { authUrl: `${origins.auth}/` };
}

async function dispatch(
  request: SetupRequest,
  http: Request,
  deps: SetupDependencies,
) {
  switch (request.action) {
    case "claim":
      if (!isTokenShaped(request.token))
        throw new SetupFailure(claimError("invalid-token"));
      return claim(request.token, deps);
    case "scan":
      return scan(request, deps);
    case "step":
      return step(request, deps);
    case "finish":
      return finish(request, http, deps);
  }
}

function hasShapedToken(request: SetupRequest) {
  return isTokenShaped(
    request.action === "claim" ? request.token : request.claim.token,
  );
}

// Errors here can carry the token, because it is in the request body and in
// the Cloudflare client. Only named failures reach the response, and the log
// gets the error's type and nothing else.
export async function handleSetupRequest(
  http: Request,
  deps: SetupDependencies,
): Promise<Response> {
  try {
    const { primaryDomain } = await readSettings(deps.database);
    if (primaryDomain !== null) return failure(ALREADY_FINISHED);

    const parsed = parseSetupRequest(await http.json().catch(() => null));
    if (!parsed) return failure(BAD_REQUEST);
    if (!hasShapedToken(parsed)) return failure(claimError("invalid-token"));

    return success(await dispatch(parsed, http, deps));
  } catch (error) {
    if (error instanceof SetupFailure) return failure(error.detail);
    if (error instanceof CloudflareError) {
      return failure({
        code: "cloudflare",
        message: `Cloudflare said: ${error.message}`,
      });
    }
    console.error(
      "Setup request failed:",
      error instanceof Error ? error.name : typeof error,
    );
    return failure({
      code: "unexpected",
      message:
        "Something went wrong on our side. Try again. Your progress is safe.",
    });
  }
}
