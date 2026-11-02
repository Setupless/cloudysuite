import { queryOptions } from "@tanstack/react-query";
import { readDrafts } from "../../pwa/saved-mail";
import { call, mailKeys } from "../../queries";
import type { MailboxId } from "../../types";
import {
  getComposeContext,
  listOutgoing,
  suggestAddresses,
} from "../functions";
import type {
  DraftBase,
  DraftStart,
  OutgoingAttachment,
  OutgoingId,
  OutgoingSummary,
} from "../types";

const ACTIVE_REFRESH_MS = 1_500;
// Nothing here is new mail. Someone's own sends use the faster rate above.
const IDLE_REFRESH_MS = 60_000;

const composeKey = (mailboxId: MailboxId) =>
  [...mailKeys.all(mailboxId), "compose"] as const;

export const composeKeys = {
  outgoing: (mailboxId: MailboxId) =>
    [...composeKey(mailboxId), "outgoing"] as const,
};

export const composeContextQuery = (mailboxId: MailboxId) =>
  queryOptions({
    queryKey: [...composeKey(mailboxId), "context"] as const,
    queryFn: () => call(() => getComposeContext({ data: { mailboxId } })),
    staleTime: 5 * 60_000,
  });

export const suggestionsQuery = (mailboxId: MailboxId, query: string) =>
  queryOptions({
    queryKey: [...composeKey(mailboxId), "suggestions", query] as const,
    queryFn: () => call(() => suggestAddresses({ data: { mailboxId, query } })),
    enabled: query.length > 0,
    staleTime: 60_000,
  });

export const isOnItsWay = ({ state }: OutgoingSummary) =>
  state === "scheduled" || state === "sending" || state === "accepted";

export const outgoingQuery = (mailboxId: MailboxId) =>
  queryOptions({
    queryKey: composeKeys.outgoing(mailboxId),
    queryFn: () =>
      call(() => readDrafts(() => listOutgoing({ data: { mailboxId } }))),
    refetchInterval: (query) =>
      query.state.data?.some(isOnItsWay) ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS,
    refetchIntervalInBackground: false,
  });

const CANNOT_REACH =
  "We couldn't reach CloudySuite, so that file wasn't attached. Check your connection and try again.";

export class UploadRefused extends Error {}

// Someone changed the draft since this screen last looked, so the file wasn't added.
export class DraftMovedOn extends Error {}

export type UploadedFile = {
  attachment: OutgoingAttachment;
  revision: number;
  carried: OutgoingAttachment[];
  originalGone: boolean;
};

export async function uploadAttachment(
  mailboxId: MailboxId,
  id: OutgoingId,
  file: File,
  start: DraftStart | undefined,
  { baseRevision, session }: DraftBase,
): Promise<UploadedFile> {
  const params = new URLSearchParams({
    name: file.name,
    base: String(baseRevision),
    session,
  });
  if (start) params.set("start", JSON.stringify(start));
  let response: Response;
  try {
    response = await fetch(
      `/api/compose/${mailboxId}/${id}/attachments?${params}`,
      {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      },
    );
  } catch {
    throw new UploadRefused(CANNOT_REACH);
  }
  const body = (await response.json().catch(() => null)) as
    (UploadedFile & { message?: string; status?: string }) | null;
  if (body?.status === "behind") throw new DraftMovedOn();
  if (!response.ok || !body) {
    throw new UploadRefused(body?.message ?? CANNOT_REACH);
  }
  return body;
}
