import { type DriveId } from "@cloudysuite/access";
import { UploadRefused } from "@cloudysuite/transfer";
import type { ItemId } from "../types";

// Where files go. Home's uploads go to My files, which may not exist until the first
// one arrives.
export type Destination =
  | { kind: "myFiles" }
  | { kind: "folder"; driveId: DriveId; folderId: ItemId | null; name: string };

export const destinationName = (destination: Destination) =>
  destination.kind === "myFiles" ? "My files" : destination.name;

const destinationKey = (destination: Destination) =>
  destination.kind === "myFiles"
    ? "myFiles"
    : `${destination.driveId}/${destination.folderId ?? ""}`;

export type QueuedFile = {
  id: number;
  file: File;
  state: "queued" | "sending" | "sent" | "refused";
  sentBytes: number;
  message: string | null;
};

export type WaitReason = "connection" | "folderMoving";

// One line of the tray: a set of files going to one place. `sessionBytes` and
// `sendingSince` leave out what an earlier visit stored, so the time left is honest.
export type UploadBatch = {
  id: number;
  key: string;
  name: string;
  destination: Destination;
  files: QueuedFile[];
  waiting: WaitReason | null;
  sessionBytes: number;
  sendingSince: number | null;
};

export type SendFile = (input: {
  driveId: DriveId;
  folderId: ItemId | null;
  file: File;
  signal: AbortSignal;
  onSentBytes: (bytes: number) => void;
  onWaiting: (reason: WaitReason) => void;
}) => Promise<void>;

export type QueueEffects = {
  ensureMyFiles: () => Promise<DriveId>;
  sendFile: SendFile;
  onFileSent: () => void;
};

const NOTHING: readonly UploadBatch[] = [];

// Lives above the routes, so an upload keeps going while the person moves around.
export class UploadQueue {
  readonly #effects: QueueEffects;
  #batches: readonly UploadBatch[] = NOTHING;
  #listeners = new Set<() => void>();
  #nextId = 1;
  #current: { batchId: number; abort: AbortController } | null = null;
  #running = false;

  constructor(effects: QueueEffects) {
    this.#effects = effects;
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  snapshot = () => this.#batches;

  isBusy = () =>
    this.#batches.some((batch) =>
      batch.files.some(
        (file) => file.state === "queued" || file.state === "sending",
      ),
    );

  add(destination: Destination, files: readonly File[]): void {
    if (files.length === 0) return;
    const queued = files.map((file): QueuedFile => ({
      id: this.#nextId++,
      file,
      state: "queued",
      sentBytes: 0,
      message: null,
    }));
    const key = destinationKey(destination);
    // A finished line for the same place gives way, so the tray can't pile up.
    const kept = this.#batches.filter(
      (batch) =>
        batch.key !== key || batch.files.some((file) => file.state !== "sent"),
    );
    const open = kept.find((batch) => batch.key === key);
    this.#set(
      open
        ? kept.map((batch) =>
            batch === open
              ? { ...batch, files: [...batch.files, ...queued] }
              : batch,
          )
        : [
            ...kept,
            {
              id: this.#nextId++,
              key,
              name: destinationName(destination),
              destination,
              files: queued,
              waiting: null,
              sessionBytes: 0,
              sendingSince: null,
            },
          ],
    );
    void this.#run();
  }

  // Parts already stored stay on the server, so picking the file again carries on.
  close(batchId: number): void {
    if (this.#current?.batchId === batchId) this.#current.abort.abort();
    this.#set(this.#batches.filter((batch) => batch.id !== batchId));
  }

  #set(batches: readonly UploadBatch[]) {
    this.#batches = batches;
    for (const listener of this.#listeners) listener();
  }

  #update(batchId: number, change: (batch: UploadBatch) => UploadBatch) {
    this.#set(
      this.#batches.map((batch) =>
        batch.id === batchId ? change(batch) : batch,
      ),
    );
  }

  #updateFile(
    batchId: number,
    fileId: number,
    change: Partial<QueuedFile>,
    batchChange: Partial<UploadBatch> = {},
  ) {
    this.#update(batchId, (batch) => ({
      ...batch,
      ...batchChange,
      files: batch.files.map((file) =>
        file.id === fileId ? { ...file, ...change } : file,
      ),
    }));
  }

  #nextQueued() {
    for (const batch of this.#batches) {
      const file = batch.files.find((item) => item.state === "queued");
      if (file) return { batch, file };
    }
    return null;
  }

  async #run() {
    if (this.#running) return;
    this.#running = true;
    for (let next = this.#nextQueued(); next; next = this.#nextQueued()) {
      await this.#send(next.batch.id, next.file);
    }
    this.#running = false;
  }

  async #send(batchId: number, queued: QueuedFile) {
    const abort = new AbortController();
    this.#current = { batchId, abort };
    this.#updateFile(batchId, queued.id, { state: "sending" });
    const batch = this.#batches.find((item) => item.id === batchId);
    if (!batch) return;
    let lastSent: number | null = null;

    try {
      const { destination } = batch;
      const target =
        destination.kind === "myFiles"
          ? {
              driveId: await this.#effects.ensureMyFiles(),
              folderId: null,
            }
          : destination;
      await this.#effects.sendFile({
        driveId: target.driveId,
        folderId: target.folderId,
        file: queued.file,
        signal: abort.signal,
        onSentBytes: (bytes) => {
          const fresh = lastSent === null ? 0 : bytes - lastSent;
          lastSent = bytes;
          this.#update(batchId, (current) => ({
            ...current,
            waiting: null,
            sessionBytes: current.sessionBytes + fresh,
            sendingSince: current.sendingSince ?? Date.now(),
            files: current.files.map((file) =>
              file.id === queued.id ? { ...file, sentBytes: bytes } : file,
            ),
          }));
        },
        onWaiting: (reason) => {
          this.#update(batchId, (current) => ({ ...current, waiting: reason }));
        },
      });
      this.#updateFile(
        batchId,
        queued.id,
        { state: "sent", sentBytes: queued.file.size },
        { waiting: null },
      );
      this.#effects.onFileSent();
    } catch (error) {
      if (abort.signal.aborted) return;
      this.#updateFile(
        batchId,
        queued.id,
        {
          state: "refused",
          message:
            error instanceof UploadRefused || error instanceof Error
              ? error.message
              : "We couldn't send this file. Try again.",
        },
        { waiting: null },
      );
    }
  }
}

export function batchProgress(batch: UploadBatch) {
  const live = batch.files.filter((file) => file.state !== "refused");
  const totalBytes = live.reduce((sum, file) => sum + file.file.size, 0);
  const sentBytes = live.reduce((sum, file) => sum + file.sentBytes, 0);
  const finished = batch.files.every(
    (file) => file.state === "sent" || file.state === "refused",
  );
  return {
    totalBytes,
    sentBytes,
    finished,
    sent: batch.files.filter((file) => file.state === "sent").length,
    refused: batch.files.filter((file) => file.state === "refused"),
    fraction: totalBytes === 0 ? (finished ? 1 : 0) : sentBytes / totalBytes,
  };
}

export function timeLeftText(batch: UploadBatch, now: number): string {
  const { totalBytes, sentBytes } = batchProgress(batch);
  const elapsed = batch.sendingSince === null ? 0 : now - batch.sendingSince;
  if (batch.sessionBytes === 0 || elapsed <= 0) {
    return "Working out the time left.";
  }
  const seconds =
    ((totalBytes - sentBytes) / batch.sessionBytes) * (elapsed / 1000);
  if (seconds < 60) return "Less than a minute left.";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} left.`;
  }
  const hours = Math.round(minutes / 60);
  return `About ${hours} ${hours === 1 ? "hour" : "hours"} left.`;
}
