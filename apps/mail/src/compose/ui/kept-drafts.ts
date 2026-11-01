import type { UserId } from "@cloudysuite/access";
import { queryOptions } from "@tanstack/react-query";
import { forgetKeptDraft, readKeptDrafts } from "../../pwa/device-store";
import { callAction } from "../../queries";
import { saveDraft } from "../functions";
import { moveToDrafts } from "../kept";
import type { KeptDraft, OutgoingId } from "../types";

export const keptDraftsQuery = (userId: UserId) =>
  queryOptions({
    queryKey: ["mail", "kept", userId] as const,
    queryFn: () => readKeptDrafts(userId),
    retry: false,
    staleTime: 0,
  });

// Each one that goes is forgotten only after the server has it. Whatever fails stays
// here for the next try, and the one open in an editor is that editor's to save.
export async function saveKeptDrafts(
  userId: UserId,
  openId: OutgoingId | undefined,
): Promise<{ draft: KeptDraft; savedAs: OutgoingId }[]> {
  const moved: { draft: KeptDraft; savedAs: OutgoingId }[] = [];
  for (const draft of await readKeptDrafts(userId)) {
    if (draft.id === openId) continue;
    try {
      const savedAs = await moveToDrafts(
        draft,
        (id) =>
          callAction(() =>
            saveDraft({
              data: {
                mailboxId: draft.mailboxId,
                id,
                baseRevision: draft.revision,
                content: draft.content,
              },
            }),
          ),
        () => crypto.randomUUID() as OutgoingId,
      );
      await forgetKeptDraft(userId, draft.id, draft.keptAt);
      moved.push({ draft, savedAs });
    } catch {
      // Still on this device, and the band says so.
    }
  }
  return moved;
}
