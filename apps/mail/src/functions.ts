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
import type { MailboxId, MailboxSummary } from "./types";
import {
  parseFlagsInput,
  parseListInput,
  parseMessageInput,
  parseMoveInput,
  parseSelectionInput,
  parseThreadInput,
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
