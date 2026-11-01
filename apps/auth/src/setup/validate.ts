import { isAppId } from "../../../../src/routing";
import {
  type Claim,
  type DomainChoice,
  type FirstAdminInput,
  PASSWORD_LENGTH,
  type SetupRequest,
  STEP_IDS,
  type StepId,
} from "./model";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const isAppLabel = (label: string) =>
  LABEL.test(label) && !isAppId(label);

const LOCAL_PART = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
export const isMailboxLocalPart = (local: string) =>
  local.length <= 64 && LOCAL_PART.test(local);

// The same rule Better Auth's sign-in applies, so an address saved here can
// always sign in.
const EMAIL =
  /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;
export const isEmail = (email: string) =>
  email.length <= 254 && EMAIL.test(email);

export const isPasswordAllowed = (password: string) =>
  password.length >= PASSWORD_LENGTH.min &&
  password.length <= PASSWORD_LENGTH.max;

function parseClaim(value: unknown): Claim | null {
  if (!isObject(value)) return null;
  const { token, accountId, scriptName } = value;
  if (!isString(token) || !isString(accountId) || !isString(scriptName))
    return null;
  if (!/^[0-9a-f]{32}$/.test(accountId) || scriptName.length === 0) return null;
  return { token, accountId, scriptName };
}

function parseChoice(value: unknown): DomainChoice | null {
  if (!isObject(value) || !isString(value.zoneId)) return null;
  const { zoneId, appLabel } = value;
  if (appLabel === null) return { zoneId, appLabel: null };
  return isString(appLabel) && isAppLabel(appLabel)
    ? { zoneId, appLabel }
    : null;
}

function parseAdmin(value: unknown): FirstAdminInput | null {
  if (!isObject(value)) return null;
  const { name, email, password, mailboxLocalPart } = value;
  if (!isString(name) || !isString(email) || !isString(password)) return null;
  if (!isString(mailboxLocalPart)) return null;
  const trimmedName = name.trim();
  const trimmedEmail = email.trim().toLowerCase();
  const local = mailboxLocalPart.trim().toLowerCase();
  if (trimmedName.length === 0 || trimmedName.length > 100) return null;
  if (
    !isEmail(trimmedEmail) ||
    !isPasswordAllowed(password) ||
    !isMailboxLocalPart(local)
  ) {
    return null;
  }
  return {
    name: trimmedName,
    email: trimmedEmail,
    password,
    mailboxLocalPart: local,
  };
}

export function parseSetupRequest(value: unknown): SetupRequest | null {
  if (!isObject(value)) return null;
  switch (value.action) {
    case "claim":
      return isString(value.token)
        ? { action: "claim", token: value.token }
        : null;
    case "scan": {
      const claim = parseClaim(value.claim);
      return claim && isString(value.zoneId)
        ? { action: "scan", claim, zoneId: value.zoneId }
        : null;
    }
    case "step": {
      const claim = parseClaim(value.claim);
      const choice = parseChoice(value.choice);
      const stepId = STEP_IDS.find((id: StepId) => id === value.stepId);
      const mode =
        value.mode === "check" || value.mode === "run" ? value.mode : null;
      const { confirmReplace } = value;
      if (confirmReplace !== undefined && !isString(confirmReplace))
        return null;
      return claim && choice && stepId && mode
        ? { action: "step", claim, choice, stepId, mode, confirmReplace }
        : null;
    }
    case "finish": {
      const claim = parseClaim(value.claim);
      const choice = parseChoice(value.choice);
      const admin = parseAdmin(value.admin);
      return claim && choice && admin
        ? { action: "finish", claim, choice, admin }
        : null;
    }
    default:
      return null;
  }
}
