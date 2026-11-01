import { redirect } from "@tanstack/react-router";
import { firstMailbox } from "./functions";
import { readFirstMailbox } from "./pwa/saved-mail";

export async function redirectToFirstMailbox(): Promise<void> {
  const mailboxId = await readFirstMailbox(() => firstMailbox());
  if (mailboxId) {
    throw redirect({
      to: "/mail/$mailboxId/$view",
      params: { mailboxId, view: "inbox" },
    });
  }
}
