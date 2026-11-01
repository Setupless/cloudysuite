import { env } from "cloudflare:workers";
import { requireReadyUser } from "@cloudysuite/auth/guard";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { readSettings } from "../../../src/settings";
import {
  addresses,
  type MailboxKind,
  type MailboxRole,
  mailboxAccess,
  mailboxes,
} from "../../../src/db/schema";
import { openMailboxAs, openMailboxFor } from "./access";
import { renderBody } from "./email/render-body";
import type { LabelWrite } from "./labels/store";
import type { MailboxId, MailboxSummary } from "./types";
import {
  parseFlagsInput,
  parseLabelChangeInput,
  parseLabelInput,
  parseListInput,
  parseMessageInput,
  parseMoveInput,
  parseNewLabelInput,
  parseSearchInput,
  parseSelectionInput,
  parseSetLabelInput,
  parseThreadInput,
  refusal,
} from "./wire";

export type MailboxEntry = {
  id: MailboxId;
  kind: MailboxKind;
  name: string;
  role: MailboxRole;
  address: string | null;
  summary: MailboxSummary;
};

const openFor = (mailboxId: MailboxId) =>
  openMailboxFor(getRequest(), mailboxId);

export const listMailboxes = createServerFn({ method: "GET" }).handler(
  async (): Promise<MailboxEntry[]> => {
    const user = await requireReadyUser(getRequest());
    const rows = await drizzle(env.DB)
      .select({
        id: mailboxes.id,
        kind: mailboxes.kind,
        name: mailboxes.name,
        role: mailboxAccess.role,
      })
      .from(mailboxAccess)
      .innerJoin(mailboxes, eq(mailboxes.id, mailboxAccess.mailboxId))
      .where(eq(mailboxAccess.userId, user.id))
      .orderBy(asc(mailboxes.kind), asc(mailboxes.name));
    const primary = await drizzle(env.DB)
      .select({ mailboxId: addresses.mailboxId, address: addresses.address })
      .from(addresses)
      .where(eq(addresses.kind, "primary"));
    const addressOf = new Map(
      primary.map((row) => [row.mailboxId, row.address]),
    );
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        address: addressOf.get(row.id) ?? null,
        summary: await (await openMailboxAs(user.id, row.id)).summary(),
      })),
    );
  },
);

export const firstMailbox = createServerFn({ method: "GET" }).handler(
  async (): Promise<MailboxId | null> => {
    const user = await requireReadyUser(getRequest());
    const [row] = await drizzle(env.DB)
      .select({ id: mailboxes.id })
      .from(mailboxAccess)
      .innerJoin(mailboxes, eq(mailboxes.id, mailboxAccess.mailboxId))
      .where(eq(mailboxAccess.userId, user.id))
      .orderBy(asc(mailboxes.kind), asc(mailboxes.name))
      .limit(1);
    return row?.id ?? null;
  },
);

export const listThreads = createServerFn({ method: "GET" })
  .validator(parseListInput)
  .handler(async ({ data: { mailboxId, ...query } }) =>
    (await openFor(mailboxId)).listThreads(query),
  );

// POST so that a hostile length reaches the parser, and gets a plain answer, rather
// than stopping at a URL limit.
export const searchThreads = createServerFn({ method: "POST" })
  .validator(parseSearchInput)
  .handler(async ({ data: { mailboxId, ...input } }) =>
    (await openFor(mailboxId)).search(input),
  );

export const getThread = createServerFn({ method: "GET" })
  .validator(parseThreadInput)
  .handler(async ({ data }) =>
    (await openFor(data.mailboxId)).getThread(data.threadId),
  );

export const findThreadOfMessage = createServerFn({ method: "GET" })
  .validator(parseMessageInput)
  .handler(async ({ data }) =>
    (await openFor(data.mailboxId)).threadOfMessage(data.messageId),
  );

export const getMessageBody = createServerFn({ method: "GET" })
  .validator(parseMessageInput)
  .handler(async ({ data }) => {
    const mailbox = await openFor(data.mailboxId);
    const { primaryDomain } = await readSettings(env.DB);
    // The hostname router sends every request to /setup until a domain is stored.
    if (primaryDomain === null) throw new Error("No primary domain is stored.");
    return renderBody(mailbox, data.messageId, primaryDomain);
  });

export const setFlags = createServerFn({ method: "POST" })
  .validator(parseFlagsInput)
  .handler(async ({ data }) =>
    (await openFor(data.mailboxId)).setFlags(data.selection, data.flags),
  );

export const moveToFolder = createServerFn({ method: "POST" })
  .validator(parseMoveInput)
  .handler(async ({ data }) =>
    (await openFor(data.mailboxId)).moveToFolder(data.selection, data.folder),
  );

export const moveToTrash = createServerFn({ method: "POST" })
  .validator(parseSelectionInput)
  .handler(async ({ data }) =>
    (await openFor(data.mailboxId)).moveToTrash(data.selection),
  );

export const restoreMessages = createServerFn({ method: "POST" })
  .validator(parseSelectionInput)
  .handler(async ({ data }) =>
    (await openFor(data.mailboxId)).restore(data.selection),
  );

export const deleteForever = createServerFn({ method: "POST" })
  .validator(parseSelectionInput)
  .handler(async ({ data }) =>
    (await openFor(data.mailboxId)).deleteForever(data.selection),
  );

function labelOrRefusal(write: LabelWrite) {
  if (!write.ok) throw refusal(write.status, write.message);
  return write.label;
}

export const createLabel = createServerFn({ method: "POST" })
  .validator(parseNewLabelInput)
  .handler(async ({ data }) =>
    labelOrRefusal(
      await (await openFor(data.mailboxId)).createLabel(data.name, data.colour),
    ),
  );

export const updateLabel = createServerFn({ method: "POST" })
  .validator(parseLabelChangeInput)
  .handler(async ({ data: { mailboxId, labelId, ...change } }) =>
    labelOrRefusal(
      await (await openFor(mailboxId)).updateLabel(labelId, change),
    ),
  );

export const deleteLabel = createServerFn({ method: "POST" })
  .validator(parseLabelInput)
  .handler(async ({ data }) =>
    (await openFor(data.mailboxId)).deleteLabel(data.labelId),
  );

export const setLabel = createServerFn({ method: "POST" })
  .validator(parseSetLabelInput)
  .handler(async ({ data }) => {
    const mailbox = await openFor(data.mailboxId);
    const done = await mailbox.setLabel(
      data.selection,
      data.labelId,
      data.applied,
    );
    if (!done) throw refusal(404, "That label isn't here anymore.");
    return done;
  });
