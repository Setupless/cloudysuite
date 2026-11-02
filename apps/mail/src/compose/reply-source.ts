import type { MailboxClient } from "../client";
import type { ReplySource } from "./outgoing";
import type { DraftStart } from "./types";

// Null when the message is gone, which can happen at any point before a reply has a row.
export async function readReplySource(
  mailbox: Pick<
    MailboxClient,
    "threadOfMessage" | "getThread" | "getBody" | "getAttachment"
  >,
  { mode, parentMessageId }: Pick<DraftStart, "mode" | "parentMessageId">,
  sender: { ownAddresses: readonly string[]; ownDomain: string },
): Promise<ReplySource | null> {
  const threadId = await mailbox.threadOfMessage(parentMessageId);
  const thread = threadId ? await mailbox.getThread(threadId) : null;
  const parent = thread?.messages.find((one) => one.id === parentMessageId);
  if (!parent) return null;
  return {
    mode,
    parent,
    body: (await mailbox.getBody(parent.id)) ?? { text: null, html: null },
    inlineAttachments: parent.attachments.map((info) => ({
      info,
      read: async () => {
        const download = await mailbox.getAttachment(parent.id, info.id);
        return download ? new Response(download.body).arrayBuffer() : null;
      },
    })),
    ...sender,
  };
}
