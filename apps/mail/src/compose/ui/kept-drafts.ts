import type { UserId } from "@cloudysuite/access";
import { queryOptions } from "@tanstack/react-query";
import {
  readKeptNoteRows,
  readKeptRows,
  settleKeptDraft,
} from "../../pwa/device-store";
import { callAction } from "../../queries";
import type { MailboxId } from "../../types";
import { saveDraft } from "../functions";
import {
  isLeftOut,
  keptHoldsSomething,
  moveToDrafts,
  parseKeptDraft,
  parseKeptNote,
} from "../kept";
import {
  type KeptDraft,
  type KeptNote,
  type OutgoingId,
  startOf,
} from "../types";

const readEveryKept = async (userId: UserId): Promise<KeptDraft[]> =>
  (await readKeptRows(userId))
    .map(parseKeptDraft)
    .filter((draft) => draft !== null);

// An earlier build could keep text someone had cleared, which isn't worth offering back.
export const readKeptDrafts = async (userId: UserId): Promise<KeptDraft[]> =>
  (await readEveryKept(userId)).filter(keptHoldsSomething);

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
  note: KeptNote | null;
};

// Each one that goes is forgotten only after the server has it. Whatever fails stays
// here for the next try, and the one open in an editor is that editor's to save. A
// mailbox this person has lost is skipped: those words aren't for it any more. What holds
// nothing anyone added just goes.
export async function saveKeptDrafts(
  userId: UserId,
  openId: OutgoingId | undefined,
  mayWrite: (mailboxId: MailboxId) => boolean,
): Promise<MovedDraft[]> {
  const moved: MovedDraft[] = [];
  for (const draft of await readEveryKept(userId)) {
    if (draft.id === openId || !mayWrite(draft.mailboxId)) continue;
    try {
      const result = await moveToDrafts(draft, () =>
        callAction(() =>
          saveDraft({
            data: {
              mailboxId: draft.mailboxId,
              id: draft.id,
              baseRevision: draft.revision,
              session: draft.session,
              written: draft.written,
              fileComing: false,
              showing: draft.attachments,
              // Nobody is here to choose, so words for a message already gone get their own.
              whenLocked: "copy",
              content: draft.content,
              start: startOf(draft),
            },
          }),
        ),
      );
      if (!result) {
        await settleKeptDraft(userId, draft.id, draft.keptAt, null);
        continue;
      }
      const { savedAs, leftOut, changed } = result;
      const note =
        isLeftOut(leftOut) || changed
          ? {
              id: savedAs,
              mailboxId: draft.mailboxId,
              subject: draft.content.subject,
              leftOut,
              changed,
            }
          : null;
      await settleKeptDraft(userId, draft.id, draft.keptAt, note);
      moved.push({ draft, savedAs, note });
    } catch {
      // Still on this device, and the band says so.
    }
  }
  return moved;
}
