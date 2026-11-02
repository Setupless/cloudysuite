// A file on its way makes the row when it lands, so going first would leave the row behind.
// Stopping the upload can't help: its bytes may already have arrived, and then nothing here
// could tell when the row appears. An upload that failed may have landed before its answer
// was lost, so it needs the discard too, which is harmless if no row came of it.
export async function discardWhenSettled({
  uploads,
  saving,
  hasRow,
  discard,
}: {
  uploads: ReadonlySet<Promise<unknown>>;
  saving: Promise<void>;
  hasRow: () => boolean;
  discard: () => Promise<unknown>;
}): Promise<void> {
  const uploadsRan = uploads.size > 0;
  await Promise.all(uploads);
  await saving;
  if (uploadsRan || hasRow()) await discard();
}
