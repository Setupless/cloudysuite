import { queryOptions } from "@tanstack/react-query";
import { readDrafts } from "../../pwa/saved-mail";
import { call, mailKeys, REFRESH_MS } from "../../queries";
import type { MailboxId } from "../../types";
import {
  getComposeContext,
  listOutgoing,
  suggestAddresses,
} from "../functions";
import type { OutgoingAttachment, OutgoingId, OutgoingSummary } from "../types";

const ACTIVE_REFRESH_MS = 1_500;

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
      query.state.data?.some(isOnItsWay) ? ACTIVE_REFRESH_MS : REFRESH_MS,
    refetchIntervalInBackground: false,
  });

const CANNOT_REACH =
  "We couldn't reach CloudySuite, so that file wasn't attached. Check your connection and try again.";

export class UploadRefused extends Error {}

export async function uploadAttachment(
  mailboxId: MailboxId,
  id: OutgoingId,
  file: File,
): Promise<OutgoingAttachment> {
  let response: Response;
  try {
    response = await fetch(
      `/api/compose/${mailboxId}/${id}/attachments?name=${encodeURIComponent(file.name)}`,
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
    (OutgoingAttachment & { message?: string }) | null;
  if (!response.ok || !body) {
    throw new UploadRefused(body?.message ?? CANNOT_REACH);
  }
  return body;
}
