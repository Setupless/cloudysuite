import type { SendFailure } from "./types";

export type SendOutcome =
  | { kind: "rejected"; failure: SendFailure }
  | { kind: "temporary" }
  | { kind: "ambiguous" };

// Codes from https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
// The docs don't say which are safe to repeat, so anything not listed here, including
// E_INTERNAL_SERVER_ERROR, is ambiguous: the message may have gone out, and a duplicate
// is worse than asking the person to check. A rate limit is the one refusal that
// clearly happens before anything is accepted and clears up by itself.
const REJECTED: Record<string, SendFailure> = {
  E_VALIDATION_ERROR: "invalidMessage",
  E_FIELD_MISSING: "invalidMessage",
  E_HEADER_NOT_ALLOWED: "invalidMessage",
  E_HEADER_USE_API_FIELD: "invalidMessage",
  E_HEADER_VALUE_INVALID: "invalidMessage",
  E_HEADER_VALUE_TOO_LONG: "invalidMessage",
  E_HEADER_NAME_INVALID: "invalidMessage",
  E_HEADERS_TOO_LARGE: "invalidMessage",
  E_HEADERS_TOO_MANY: "invalidMessage",
  E_TOO_MANY_RECIPIENTS: "tooManyRecipients",
  E_TOO_MANY_ATTACHMENTS: "tooLarge",
  E_CONTENT_TOO_LARGE: "tooLarge",
  E_SENDER_NOT_VERIFIED: "senderNotVerified",
  E_SENDER_DOMAIN_NOT_AVAILABLE: "senderDomainUnavailable",
  E_RECIPIENT_NOT_ALLOWED: "recipientNotAllowed",
  E_RECIPIENT_SUPPRESSED: "recipientSuppressed",
  E_ACCOUNT_SUSPENDED: "accountSuspended",
  E_DAILY_LIMIT_EXCEEDED: "dailyLimit",
  E_DELIVERY_FAILED: "deliveryRefused",
};

const TEMPORARY = new Set(["E_RATE_LIMIT_EXCEEDED"]);

export function judgeSendError(thrown: unknown): SendOutcome {
  const code = (thrown as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return { kind: "ambiguous" };
  if (TEMPORARY.has(code)) return { kind: "temporary" };
  const failure = Object.hasOwn(REJECTED, code) ? REJECTED[code] : undefined;
  return failure ? { kind: "rejected", failure } : { kind: "ambiguous" };
}

const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];

// Null when the tries have run out.
export const retryDelay = (attempts: number): number | null =>
  RETRY_DELAYS_MS[attempts] ?? null;

const STORE_RETRY_MS = 60_000;
const STORE_RETRY_CAP_MS = 60 * 60_000;

// The message has gone out and only our copy is missing, so this never gives up.
export const storeRetryDelay = (attempts: number): number =>
  Math.min(STORE_RETRY_MS * 2 ** attempts, STORE_RETRY_CAP_MS);
