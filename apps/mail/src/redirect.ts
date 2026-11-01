import { redirect } from "@tanstack/react-router";
import { firstMailbox } from "./functions";

export async function redirectToFirstMailbox(): Promise<void> {
  const mailboxId = await firstMailbox();
  if (mailboxId) {
    throw redirect({
      to: "/mail/$mailboxId/$view",
      params: { mailboxId, view: "inbox" },
    });
  }
}
