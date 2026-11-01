import { env } from "cloudflare:workers";
import { requireReadyUser } from "@cloudysuite/auth/guard";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { readSettings } from "../../../../src/settings";
import { openMailboxAs } from "../access";
import type { MailboxId, MessageDetail, MessageId } from "../types";
import { mailboxSenderFacts, refuseSenderOutsideMailbox } from "./addresses";
import type { Editor, OutgoingId, SaveResult } from "./types";
import {
  parseDiscardInput,
  parseOutgoingInput,
  parseRemoveAttachmentInput,
  parseSaveInput,
  parseStartInput,
  parseSuggestInput,
} from "./wire";
import { parseMailboxInput } from "../wire";

const SUGGESTION_MIN_LENGTH = 1;

const refuse = (status: number, message: string) =>
  new Response(JSON.stringify({ message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const NOT_FOUND =
  "This message isn't here anymore. It may have been sent or discarded.";

// The sign-in rule, then the access check, in the call that uses the grant.
async function open(mailboxId: MailboxId) {
  const user = await requireReadyUser(getRequest());
  const mailbox = await openMailboxAs(user.id, mailboxId);
  const editor: Editor = { id: user.id, name: user.name };
  return { mailbox, editor, viewerId: user.id };
}

async function ownDomain(): Promise<string> {
  const { primaryDomain } = await readSettings(env.DB);
  // The hostname router sends every request to /setup until a domain is stored.
  if (primaryDomain === null) throw new Error("No primary domain is stored.");
  return primaryDomain;
}

async function findMessage(
  mailbox: Awaited<ReturnType<typeof open>>["mailbox"],
  messageId: MessageId,
): Promise<MessageDetail> {
  const threadId = await mailbox.threadOfMessage(messageId);
  const thread = threadId ? await mailbox.getThread(threadId) : null;
  const message = thread?.messages.find((one) => one.id === messageId);
  if (!message) throw refuse(404, NOT_FOUND);
  return message;
}

export const getComposeContext = createServerFn({ method: "GET" })
  .validator(parseMailboxInput)
  .handler(async ({ data }) => {
    await open(data.mailboxId);
    return mailboxSenderFacts(env.DB, data.mailboxId);
  });

export const listOutgoing = createServerFn({ method: "GET" })
  .validator(parseMailboxInput)
  .handler(async ({ data }) => {
    const { mailbox, viewerId } = await open(data.mailboxId);
    return mailbox.outgoing.list(viewerId);
  });

export const getDraft = createServerFn({ method: "GET" })
  .validator(parseOutgoingInput)
  .handler(async ({ data }) => {
    const { mailbox, viewerId } = await open(data.mailboxId);
    const draft = await mailbox.outgoing.detail(data.id, viewerId);
    if (!draft) throw refuse(404, NOT_FOUND);
    return {
      draft,
      quoteHtml: draft.quote ? await mailbox.outgoing.quoteHtml(data.id) : null,
    };
  });

export const suggestAddresses = createServerFn({ method: "GET" })
  .validator(parseSuggestInput)
  .handler(async ({ data }) => {
    const { mailbox } = await open(data.mailboxId);
    if (data.query.length < SUGGESTION_MIN_LENGTH) return [];
    return mailbox.outgoing.suggest(data.query);
  });

export const startDraft = createServerFn({ method: "POST" })
  .validator(parseStartInput)
  .handler(async ({ data }) => {
    const { mailbox, editor, viewerId } = await open(data.mailboxId);
    const parent = await findMessage(mailbox, data.parentMessageId);
    const [body, sender, domain] = await Promise.all([
      mailbox.getBody(parent.id),
      mailboxSenderFacts(env.DB, data.mailboxId),
      ownDomain(),
    ]);
    const { notice } = await mailbox.outgoing.start({
      id: data.id,
      mode: data.mode,
      parent,
      body: body ?? { text: null, html: null },
      inlineAttachments: parent.attachments.map((info) => ({
        info,
        read: async () => {
          const download = await mailbox.getAttachment(parent.id, info.id);
          return download ? new Response(download.body).arrayBuffer() : null;
        },
      })),
      ownAddresses: sender.addresses.map(({ address }) => address),
      ownDomain: domain,
      editor,
    });
    const draft = await mailbox.outgoing.detail(data.id, viewerId);
    if (!draft) throw refuse(404, NOT_FOUND);
    return {
      draft,
      notice,
      quoteHtml: draft.quote ? await mailbox.outgoing.quoteHtml(data.id) : null,
    };
  });

export const saveDraft = createServerFn({ method: "POST" })
  .validator(parseSaveInput)
  .handler(async ({ data }): Promise<SaveResult> => {
    const { mailbox, editor } = await open(data.mailboxId);
    return mailbox.outgoing.save({
      id: data.id,
      baseRevision: data.baseRevision,
      content: data.content,
      editor,
      ownDomain: await ownDomain(),
    });
  });

// The client's From is only a request. The address must belong to this mailbox, checked
// here against the directory, in the same call that holds the mailbox's grant.
export const sendDraft = createServerFn({ method: "POST" })
  .validator(parseSaveInput)
  .handler(async ({ data }) => {
    const { mailbox, editor } = await open(data.mailboxId);
    const sender = await refuseSenderOutsideMailbox(
      env.DB,
      data.mailboxId,
      data.content.from,
    );
    const result = await mailbox.outgoing.send({
      id: data.id,
      content: data.content,
      editor,
      ownDomain: await ownDomain(),
      fromName: sender.name,
    });
    if (result.status === "refused") {
      throw refuse(result.refusal.status, result.refusal.message);
    }
    if (result.status === "locked") {
      throw refuse(
        409,
        "This message has already gone, or someone else has sent it.",
      );
    }
    return { status: "scheduled" as const };
  });

export const undoSend = createServerFn({ method: "POST" })
  .validator(parseOutgoingInput)
  .handler(async ({ data }) => {
    const { mailbox } = await open(data.mailboxId);
    return { undone: await mailbox.outgoing.undo(data.id) };
  });

export const reopenOutgoing = createServerFn({ method: "POST" })
  .validator(parseOutgoingInput)
  .handler(async ({ data }) => {
    const { mailbox } = await open(data.mailboxId);
    return { reopened: await mailbox.outgoing.reopen(data.id) };
  });

export const discardOutgoing = createServerFn({ method: "POST" })
  .validator(parseDiscardInput)
  .handler(async ({ data }) => {
    const { mailbox } = await open(data.mailboxId);
    return {
      discarded: await mailbox.outgoing.discard(data.id, data.onlyAtRevision),
    };
  });

export const removeOutgoingAttachment = createServerFn({ method: "POST" })
  .validator(parseRemoveAttachmentInput)
  .handler(async ({ data }) => {
    const { mailbox } = await open(data.mailboxId);
    const removed = await mailbox.outgoing.removeAttachment(
      data.id as OutgoingId,
      data.attachmentId,
    );
    if (!removed) {
      throw refuse(
        409,
        "This message is already on its way, so its files can't change.",
      );
    }
    return { removed };
  });
