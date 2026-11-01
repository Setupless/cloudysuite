import type { UserId } from "@cloudysuite/access";
import { queryOptions } from "@tanstack/react-query";
import {
  readKeptNoteRows,
  readKeptRows,
  settleKeptDraft,
} from "../../pwa/device-store";
import { callAction } from "../../queries";
import type { MailboxId } from "../../types";
import { saveKeptDraft } from "../functions";
import {
  isLeftOut,
  moveToDrafts,
  parseKeptDraft,
  parseKeptNote,
} from "../kept";
import type {
  DraftChange,
  KeptDraft,
  KeptNote,
  LeftOut,
  OutgoingId,
} from "../types";

export const readKeptDrafts = async (userId: UserId): Promise<KeptDraft[]> =>
  (await readKeptRows(userId))
    .map(parseKeptDraft)
    .filter((draft) => draft !== null);

const readKeptNotes = async (userId: UserId): Promise<KeptNote[]> =>
  (await readKeptNoteRows(userId))
    .map(parseKeptNote)
    .filter((note) => note !== null);

export const keptDraftsQuery = (userId: UserId) =>
  queryOptions({
    queryKey: ["mail", "kept", userId] as const,
    queryFn: () => readKeptDrafts(userId),
    retry: false,
    staleTime: 0,
  });

export const keptNotesQuery = (userId: UserId) =>
  queryOptions({
    queryKey: ["mail", "kept", userId, "notes"] as const,
    queryFn: () => readKeptNotes(userId),
    retry: false,
    staleTime: 0,
  });

export type MovedDraft = {
  draft: KeptDraft;
  savedAs: OutgoingId;
  leftOut: LeftOut;
  changed: DraftChange | null;
};

// Each one that goes is forgotten only after the server has it. Whatever fails stays
// here for the next try, and the one open in an editor is that editor's to save. A
// mailbox this person has lost is skipped: those words aren't for it any more.
export async function saveKeptDrafts(
  userId: UserId,
  openId: OutgoingId | undefined,
  mayWrite: (mailboxId: MailboxId) => boolean,
): Promise<MovedDraft[]> {
  const moved: MovedDraft[] = [];
  for (const draft of await readKeptDrafts(userId)) {
    if (draft.id === openId || !mayWrite(draft.mailboxId)) continue;
    try {
      const { savedAs, leftOut, changed } = await moveToDrafts(
        draft,
        (copyId) =>
          callAction(() =>
            saveKeptDraft({
              data: {
                mailboxId: draft.mailboxId,
                id: draft.id,
                copyId,
                baseRevision: draft.revision,
                content: draft.content,
              },
            }),
          ),
      );
      await settleKeptDraft(
        userId,
        draft.id,
        draft.keptAt,
        isLeftOut(leftOut) || changed
          ? {
              id: savedAs,
              mailboxId: draft.mailboxId,
              subject: draft.content.subject,
              leftOut,
              changed,
            }
          : null,
      );
      moved.push({ draft, savedAs, leftOut, changed });
    } catch {
      // Still on this device, and the band says so.
    }
  }
  return moved;
}
