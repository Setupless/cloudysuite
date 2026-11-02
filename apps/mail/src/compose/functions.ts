import { env } from "cloudflare:workers";
import { requireReadyUser } from "@cloudysuite/auth/guard";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { readSettings } from "../../../../src/settings";
import { openMailboxAs } from "../access";
import type { MailboxId } from "../types";
import { mailboxSenderFacts, refuseSenderOutsideMailbox } from "./addresses";
import { readReplySource } from "./reply-source";
import type { DraftStart, Editor, SaveResult } from "./types";
import {
  parseDiscardInput,
  parseOutgoingInput,
  parsePrefillInput,
  parseRemoveAttachmentInput,
  parseSaveInput,
  parseSendInput,
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

const ORIGINAL_GONE =
  "The original message is gone, so this can't go out with it. Check what's left, then send it again.";

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

async function replySource(
  mailbox: Awaited<ReturnType<typeof open>>["mailbox"],
  mailboxId: MailboxId,
  replyTo: Pick<DraftStart, "mode" | "parentMessageId">,
) {
  const [sender, ownDomainName] = await Promise.all([
    mailboxSenderFacts(env.DB, mailboxId),
    ownDomain(),
  ]);
  return readReplySource(mailbox, replyTo, {
    ownAddresses: sender.addresses.map(({ address }) => address),
    ownDomain: ownDomainName,
  });
}

async function newRowFrom(
  mailbox: Awaited<ReturnType<typeof open>>["mailbox"],
  mailboxId: MailboxId,
  start: DraftStart | undefined,
) {
  const source = start && (await replySource(mailbox, mailboxId, start));
  return start && source ? { source, start } : undefined;
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

// Reads only. A reply gets a row when someone adds something to it.
export const prefillDraft = createServerFn({ method: "GET" })
  .validator(parsePrefillInput)
  .handler(async ({ data }) => {
    const { mailbox } = await open(data.mailboxId);
    const source = await replySource(mailbox, data.mailboxId, data);
    if (!source) throw refuse(404, NOT_FOUND);
    return mailbox.outgoing.prefill(source);
  });

// The original can go between opening a reply and the first word. The words matter more,
// so they save as a plain draft, and what the save holds tells the person what's missing.
export const saveDraft = createServerFn({ method: "POST" })
  .validator(parseSaveInput)
  .handler(async ({ data }): Promise<SaveResult> => {
    const { mailbox, editor } = await open(data.mailboxId);
    return mailbox.outgoing.save({
      id: data.id,
      baseRevision: data.baseRevision,
      session: data.session,
      written: data.written,
      fileComing: data.fileComing,
      showing: data.showing,
      whenLocked: data.whenLocked,
      content: data.content,
      editor,
      ownDomain: await ownDomain(),
      from: await newRowFrom(mailbox, data.mailboxId, data.start),
      leaving: data.leaving,
    });
  });

// The client's From is only a request. The address must belong to this mailbox, checked
// here against the directory, in the same call that holds the mailbox's grant.
export const sendDraft = createServerFn({ method: "POST" })
  .validator(parseSendInput)
  .handler(async ({ data }) => {
    const { mailbox, editor } = await open(data.mailboxId);
    const sender = await refuseSenderOutsideMailbox(
      env.DB,
      data.mailboxId,
      data.content.from,
    );
    const { start } = data;
    const source = start && (await replySource(mailbox, data.mailboxId, start));
    if (start && !source) throw refuse(404, ORIGINAL_GONE);
    const result = await mailbox.outgoing.send({
      id: data.id,
      baseRevision: data.baseRevision,
      session: data.session,
      content: data.content,
      editor,
      ownDomain: await ownDomain(),
      fromName: sender.name,
      from: start && source ? { source, start } : undefined,
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
    return { status: result.status };
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
    const { mailbox, editor } = await open(data.mailboxId);
    return mailbox.outgoing.discard({
      id: data.id,
      baseRevision: data.baseRevision,
      session: data.session,
      editor,
    });
  });

export const removeOutgoingAttachment = createServerFn({ method: "POST" })
  .validator(parseRemoveAttachmentInput)
  .handler(async ({ data }) => {
    const { mailbox, editor } = await open(data.mailboxId);
    const result = await mailbox.outgoing.removeAttachment({
      id: data.id,
      attachmentId: data.attachmentId,
      baseRevision: data.baseRevision,
      session: data.session,
      editor,
    });
    if (result.status === "locked") {
      throw refuse(
        409,
        "This message is already on its way, so its files can't change.",
      );
    }
    return result;
  });
