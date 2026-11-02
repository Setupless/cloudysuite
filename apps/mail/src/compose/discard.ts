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

// A save or file still on its way can make a row after the editor has gone, and a save
// that fails can leave its words on the device, so those need the discard too.
export const nothingToDiscard = (now: {
  hasRow: boolean;
  savesUnderWay: number;
  uploadsUnderWay: number;
  keptOnDevice: boolean;
  addsSomething: boolean;
}): boolean =>
  !now.hasRow &&
  now.savesUnderWay === 0 &&
  now.uploadsUnderWay === 0 &&
  !now.keptOnDevice &&
  !now.addsSomething;
