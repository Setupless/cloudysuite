import { type Cloudflare, CloudflareError, type Zone } from "./cloudflare";
import type { Claim, ClaimedWorker, ManualGuide, SetupError } from "./model";

// Each candidate costs one call to Cloudflare on the caller's own token, so
// this also limits what one request can make the Worker do.
const MAX_WORKERS_CHECKED = 50;

const TOKEN_DOCS =
  "https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/";
const ADD_DOMAIN_DOCS =
  "https://developers.cloudflare.com/fundamentals/manage-domains/add-site/";

export type ClaimFailure =
  | "invalid-token"
  | "no-domains"
  | "no-workers-permission"
  | "other-account"
  | "too-many-workers"
  | "read-only"
  | "settings-unreadable"
  | "version-unknown";

export type ClaimOutcome =
  | { ok: true; worker: ClaimedWorker; zones: Zone[] }
  | { ok: false; reason: ClaimFailure };

export function isTokenShaped(token: string): boolean {
  return /^[\x21-\x7e]{20,256}$/.test(token);
}

const tokenGuide = (action: string): ManualGuide => ({
  action,
  dashboardUrl: "https://dash.cloudflare.com/?to=/:account/api-tokens",
  docsUrl: TOKEN_DOCS,
});

const FAILURES: Record<ClaimFailure, Omit<SetupError, "code">> = {
  "invalid-token": {
    message:
      "Cloudflare didn't accept that token. Check that you copied all of it, then try again.",
  },
  "no-domains": {
    message: "This token can't see any domains.",
    guide: {
      action:
        "Add a domain to this Cloudflare account, or create a token that includes your domain. Then paste the token again.",
      dashboardUrl: "https://dash.cloudflare.com/?to=/:account/add-site",
      docsUrl: ADD_DOMAIN_DOCS,
    },
  },
  "no-workers-permission": {
    message:
      "This token can't look at your Workers, so we can't confirm that this copy is yours.",
    guide: tokenGuide(
      "Create the token again from the link on this page, keep every permission it fills in, and paste the new token.",
    ),
  },
  "other-account": {
    message:
      "This token belongs to a different Cloudflare account. Only a token from the account that runs this copy of CloudySuite can finish setup.",
    guide: tokenGuide(
      "Sign in to the Cloudflare account where you clicked Deploy, and create the token there.",
    ),
  },
  "too-many-workers": {
    message:
      "This account has too many Workers for us to find this one. We checked the 50 most recently changed.",
    guide: tokenGuide(
      "Create a token limited to this account, or deploy CloudySuite again so that it is the most recently changed Worker.",
    ),
  },
  "read-only": {
    message:
      "This token can only read your Worker. Finishing setup takes a token that can change it.",
    guide: tokenGuide(
      "Create the token again from the link on this page, keep Workers Scripts set to Edit, and paste the new token.",
    ),
  },
  "settings-unreadable": {
    message:
      "Cloudflare didn't send back this Worker's settings, so we couldn't check that your token can change it. Nothing was changed. Wait a moment and try again.",
  },
  "version-unknown": {
    message:
      "This copy of CloudySuite can't tell which version is running, so it can't check your token. Deploy it again from the Deploy button.",
  },
};

export function claimError(reason: ClaimFailure): SetupError {
  return { code: "claim-failed", ...FAILURES[reason] };
}

async function editProblem(
  api: Cloudflare,
  accountId: string,
  scriptName: string,
): Promise<ClaimFailure | null> {
  try {
    return (await api.rewriteScriptSettings(accountId, scriptName))
      ? null
      : "settings-unreadable";
  } catch (error) {
    if (error instanceof CloudflareError && error.denied) return "read-only";
    throw error;
  }
}

const isDeniedError = (error: unknown): error is CloudflareError =>
  error instanceof CloudflareError && error.denied;

// First contact: find the Worker whose version id matches the one running here.
// That also tells us this Worker's name, which it cannot otherwise learn.
export async function claimWorker(
  api: Cloudflare,
  versionId: string,
): Promise<ClaimOutcome> {
  if (!versionId) return { ok: false, reason: "version-unknown" };

  let zones: Zone[];
  try {
    zones = await api.listZones();
  } catch (error) {
    if (
      error instanceof CloudflareError &&
      (error.denied || error.status === 400)
    ) {
      return { ok: false, reason: "invalid-token" };
    }
    throw error;
  }
  if (zones.length === 0) return { ok: false, reason: "no-domains" };

  const accounts = new Map(
    zones.map((zone) => [zone.account.id, zone.account.name]),
  );
  let budget = MAX_WORKERS_CHECKED;
  let denied = false;
  let gaveUp = false;

  for (const [accountId, accountName] of accounts) {
    let scripts: Awaited<ReturnType<Cloudflare["listScripts"]>>;
    try {
      scripts = await api.listScripts(accountId);
    } catch (error) {
      if (!isDeniedError(error)) throw error;
      denied = true;
      continue;
    }
    // A fresh deployment is the newest Worker, so this usually finds it first.
    const newestFirst = [...scripts].sort((a, b) =>
      (b.modified_on ?? "").localeCompare(a.modified_on ?? ""),
    );
    for (const { id: scriptName } of newestFirst) {
      if (budget === 0) {
        gaveUp = true;
        break;
      }
      budget--;
      let found: boolean;
      try {
        found = await api.hasVersion(accountId, scriptName, versionId);
      } catch (error) {
        if (!isDeniedError(error)) throw error;
        denied = true;
        break;
      }
      if (!found) continue;
      const problem = await editProblem(api, accountId, scriptName);
      if (problem) return { ok: false, reason: problem };
      return {
        ok: true,
        worker: { accountId, accountName, scriptName },
        zones: zones.filter((zone) => zone.account.id === accountId),
      };
    }
  }
  if (denied) return { ok: false, reason: "no-workers-permission" };
  return { ok: false, reason: gaveUp ? "too-many-workers" : "other-account" };
}

// Every later call. The account and Worker names come from the browser, but
// they only say where to look: Cloudflare still has to confirm this token can
// see the running version there, and can change that Worker.
export async function proveClaim(
  api: Cloudflare,
  versionId: string,
  claim: Claim,
): Promise<ClaimFailure | null> {
  if (!versionId) return "version-unknown";
  try {
    const found = await api.hasVersion(
      claim.accountId,
      claim.scriptName,
      versionId,
    );
    if (!found) return "other-account";
    return await editProblem(api, claim.accountId, claim.scriptName);
  } catch (error) {
    if (isDeniedError(error)) return "other-account";
    throw error;
  }
}
