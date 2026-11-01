// Shared with the browser, so nothing here may import server code.

export const IMPORT_STATES = [
  "uploading",
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;
export type ImportState = (typeof IMPORT_STATES)[number];

export const IMPORT_TRANSITIONS: Record<ImportState, readonly ImportState[]> = {
  uploading: ["queued", "failed", "cancelled"],
  queued: ["running", "failed", "cancelled"],
  running: ["done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

export const isActive = (state: ImportState) =>
  IMPORT_TRANSITIONS[state].length > 0;

// Decimal, because 10,000 parts of 10 MB is exactly the 100 GB limit. R2 needs
// every part but the last to be one size, so a part of any other size is refused.
export const PART_BYTES = 10_000_000;
export const MAX_PARTS = 10_000;
export const MAX_FILE_BYTES = PART_BYTES * MAX_PARTS;

export const partCountFor = (size: number) => Math.ceil(size / PART_BYTES);

export function expectedPartBytes(size: number, partNumber: number): number {
  return partNumber < partCountFor(size)
    ? PART_BYTES
    : size - PART_BYTES * (partCountFor(size) - 1);
}

export const IMPORT_FAILURES = {
  notMbox:
    "This file isn't an mbox file, so nothing was imported. Check that you picked the right file.",
  abandoned:
    "The upload stopped for 3 days, so we removed it. Start again to import this file.",
  storage:
    "The import stopped because something went wrong while reading your file, and it kept happening after many tries. Messages already imported are safe. Start the import again to bring in the rest. If it stops at the same place, download the export again and import the new file.",
  fileMissing:
    "The uploaded file is no longer in storage. Messages already imported are safe. Start again to import the rest.",
  sizeMismatch:
    "The uploaded file didn't match the size we expected. Start again to import it.",
} as const;
export type ImportFailure = keyof typeof IMPORT_FAILURES;

export const UNREADABLE_REASONS = {
  tooLarge: "This message is larger than the 25 MB limit, so we skipped it.",
  truncated:
    "The file ends partway through this message. Download the export again to get all of it.",
  notAnEmail: "This part of the file isn't an email, so we skipped it.",
  couldNotProcess:
    "Something in this message stopped us from reading it, so we skipped it.",
} as const;
export type UnreadableReason = keyof typeof UNREADABLE_REASONS;

export type UnreadableItem = {
  // Where the item starts in the file, which also makes it unique in a job.
  offset: number;
  size: number;
  reason: UnreadableReason;
  // The message's subject and sender, if the first bytes held them.
  hint: string;
};

export type ImportJobView = {
  id: string;
  state: ImportState;
  fileName: string;
  size: number;
  // Compared by the browser, to catch a different file picked to resume.
  fingerprint: string;
  partCount: number;
  uploadedParts: number[];
  byteOffset: number;
  stored: number;
  duplicates: number;
  unreadable: number;
  failure: ImportFailure | null;
  createdAt: number;
  finishedAt: number | null;
};

export type NewImportFile = {
  fileName: string;
  size: number;
  fingerprint: string;
};
