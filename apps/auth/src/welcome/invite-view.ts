export type InviteView =
  | { state: "open"; signInEmail: string }
  | { state: "used" | "expired" | "unknown" };

const NO_LONGER_WORKS: Record<Exclude<InviteView["state"], "open">, string> = {
  used: "This invite has already been used. If that was you, sign in instead.",
  expired: "This invite has expired. Ask your admin to send a new one.",
  unknown: "This invite link isn't valid. Ask your admin to send a new one.",
};

export function inviteRefusal(
  state: Exclude<InviteView["state"], "open">,
): string {
  return NO_LONGER_WORKS[state];
}
