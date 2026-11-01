import type { MailboxId } from "@cloudysuite/access";

// Not exported from the package. Only ingest.ts and client.ts may import this,
// and boundaries.test.ts fails if anything else touches the binding.
export function mailboxStub(env: Env, mailboxId: MailboxId) {
  return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
}
