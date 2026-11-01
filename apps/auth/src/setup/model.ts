export const STEP_IDS = [
  "email-routing",
  "email-sending",
  "catch-all",
  "app-hostnames",
  "auth-secret",
] as const;
export type StepId = (typeof STEP_IDS)[number];

export type ManualGuide = {
  action: string;
  dashboardUrl: string;
  docsUrl: string;
};

// "missing" means the wizard can apply the change itself. "needs-action" means
// only the person can, and only another check can move it on.
// "needs-confirmation" means applying it would replace something in use, so the
// wizard waits until the request repeats `current`, the wording the person saw.
export type StepResult =
  | { state: "done"; detail: string }
  | { state: "missing"; detail: string }
  | { state: "needs-confirmation"; current: string }
  | { state: "needs-action"; guide: ManualGuide; retry?: boolean }
  | { state: "failed"; message: string };

export type StepMode = "check" | "run";

// The server keeps nothing between calls, so the browser re-sends this and the
// server proves it again each time.
export type Claim = { token: string; accountId: string; scriptName: string };

export type ClaimedWorker = {
  accountId: string;
  accountName: string;
  scriptName: string;
};

export type ZoneSummary = { id: string; name: string; active: boolean };

// The browser names a zone and a label. The server reads the zone's real name
// from Cloudflare, so the browser cannot choose a domain the token cannot see.
export type DomainChoice = { zoneId: string; appLabel: string | null };

// The app domain scopes the session cookie and is `domains.isPrimary`. The
// email domain is always the zone apex, because catch-all rules work only there.
export type DomainPlan = {
  zoneId: string;
  zoneName: string;
  appDomain: string;
  emailDomain: string;
};

export type ZoneScan = {
  hostedHosts: string[];
  externalMx: string[];
  // The app label to recommend. Null means the apex.
  recommendedLabel: string | null;
  resumedLabel: string | null | undefined;
};

export type FirstAdminInput = {
  name: string;
  email: string;
  password: string;
  mailboxLocalPart: string;
};

export const PASSWORD_LENGTH = { min: 8, max: 128 } as const;

export type SetupRequest =
  | { action: "claim"; token: string }
  | { action: "scan"; claim: Claim; zoneId: string }
  | {
      action: "step";
      claim: Claim;
      choice: DomainChoice;
      stepId: StepId;
      mode: StepMode;
      confirmReplace?: string;
    }
  | {
      action: "finish";
      claim: Claim;
      choice: DomainChoice;
      admin: FirstAdminInput;
    };

export type SetupErrorCode =
  | "bad-request"
  | "claim-failed"
  | "already-finished"
  | "steps-unfinished"
  | "cloudflare"
  | "unexpected";

export type SetupError = {
  code: SetupErrorCode;
  message: string;
  guide?: ManualGuide;
};

export type ClaimResponse = { worker: ClaimedWorker; zones: ZoneSummary[] };
export type ScanResponse = { scan: ZoneScan };
export type StepResponse = { result: StepResult; plan: DomainPlan };
export type FinishResponse = { authUrl: string };

export type SetupResult<Body> =
  ({ ok: true } & Body) | { ok: false; error: SetupError };
