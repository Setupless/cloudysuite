import type { EmailAddress } from "./types";

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

// Narrow on purpose: an address that could hide anything is refused. A "mailto:" in
// front is dropped, as an invitation from outside writes one.
export function parseEmailAddress(raw: unknown): EmailAddress | null {
  if (typeof raw !== "string") return null;
  const address = raw.trim().replace(/^mailto:/i, "");
  const at = address.lastIndexOf("@");
  if (at <= 0 || address.length > 254) return null;
  const local = address.slice(0, at);
  const labels = address.slice(at + 1).split(".");
  const valid =
    LOCAL_PART.test(local) &&
    !local.startsWith(".") &&
    !local.endsWith(".") &&
    !local.includes("..") &&
    labels.length >= 2 &&
    labels.every((label) => DOMAIN_LABEL.test(label));
  return valid ? (address.toLowerCase() as EmailAddress) : null;
}
