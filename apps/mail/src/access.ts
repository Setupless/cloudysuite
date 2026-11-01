import { env } from "cloudflare:workers";
import {
  checkMailboxAccess,
  type MailboxId,
  type UserId,
} from "@cloudysuite/access";
import { requireReadyUser } from "@cloudysuite/auth/guard";
import { openMailbox } from "./client";

export const NO_ACCESS_MESSAGE =
  "You don't have access to this mailbox. Ask your admin if you need it.";

// Every request a person makes to a mailbox starts here: the sign-in rule, then
// the access check, in the call that uses the grant.
export async function openMailboxFor(request: Request, mailboxId: MailboxId) {
  const user = await requireReadyUser(request);
  return openMailboxAs(user.id, mailboxId);
}

// For one request that opens several mailboxes after `requireReadyUser`.
export async function openMailboxAs(userId: UserId, mailboxId: MailboxId) {
  const access = await checkMailboxAccess(env.DB, userId, mailboxId);
  if (!access.allowed) {
    throw new Response(JSON.stringify({ message: NO_ACCESS_MESSAGE }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return openMailbox(env, access.grant);
}
