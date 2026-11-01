import type { KeptDraft, OutgoingId, SaveResult } from "./types";

// Someone may have sent this message while the words were stuck here. The words still
// matter, and a sent message can't change, so they become a draft of their own.
export async function moveToDrafts(
  draft: KeptDraft,
  save: (id: OutgoingId) => Promise<SaveResult>,
  newId: () => OutgoingId,
): Promise<OutgoingId> {
  const saved = await save(draft.id);
  if (saved.status !== "locked") return draft.id;
  const id = newId();
  await save(id);
  return id;
}
