import type { MailboxId } from "@cloudysuite/access";
import type { Mailbox } from "../mailbox";
import { importFileKey } from "../r2-keys";
import { isUploadGone } from "./r2-errors";
import type { NewImportJob, PartPlan } from "./store";
import {
  type ImportJobView,
  MAX_FILE_BYTES,
  type NewImportFile,
  type UnreadableItem,
} from "./types";

const MAX_FILE_NAME_LENGTH = 255;
const MAX_FINGERPRINT_LENGTH = 128;
const JOBS_SHOWN = 5;

export type Refused = { ok: false; status: number; message: string };
export type Accepted<Value> = { ok: true; value: Value };
export type Outcome<Value> = Accepted<Value> | Refused;

const refuse = (status: number, message: string): Refused => ({
  ok: false,
  status,
  message,
});

const NO_SUCH_IMPORT = refuse(404, "We can't find that import.");
const UPLOAD_OVER = refuse(
  409,
  "This upload has ended, so it can't take more of the file.",
);

export type ImportStatus = {
  jobs: ImportJobView[];
  unreadable: UnreadableItem[];
};

export type PartBody = {
  // From the request's headers, so a wrong size is refused before it is read.
  declaredBytes: number | null;
  // Null when the body is longer than the limit.
  read: (limit: number) => Promise<ArrayBuffer | null>;
};

// Stops at the first byte past the limit, so a client that declares one size and
// sends another cannot make the Worker hold more than a part.
export async function readUpTo(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<ArrayBuffer | null> {
  const bytes = new Uint8Array(limit);
  let length = 0;
  if (body) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  }
  return length === limit ? bytes.buffer : bytes.buffer.slice(0, length);
}

export type MailboxImports = {
  status(): Promise<ImportStatus>;
  start(file: unknown): Promise<Outcome<ImportJobView>>;
  putPart(
    jobId: string,
    partNumber: number,
    body: PartBody,
  ): Promise<Outcome<null>>;
  finishUpload(jobId: string): Promise<Outcome<ImportJobView>>;
  cancel(jobId: string): Promise<Outcome<ImportJobView>>;
};

function readFile(input: unknown): NewImportFile | Refused {
  const { fileName, size, fingerprint } = (input ?? {}) as Record<
    string,
    unknown
  >;
  if (
    typeof fileName !== "string" ||
    typeof fingerprint !== "string" ||
    fingerprint.length > MAX_FINGERPRINT_LENGTH ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size)
  ) {
    return refuse(400, "We couldn't read the details of that file.");
  }
  if (size <= 0)
    return refuse(400, "This file is empty, so there is nothing to import.");
  if (size > MAX_FILE_BYTES) {
    return refuse(
      413,
      "This file is larger than the 100 GB limit. Split it into smaller files, then import each one.",
    );
  }
  return {
    // Shown as text and never used in a storage key.
    fileName: fileName
      .replace(/\p{Cc}+/gu, " ")
      .trim()
      .slice(0, MAX_FILE_NAME_LENGTH),
    size,
    fingerprint,
  };
}

// Runs in the Worker so that file bytes never pass through the Durable Object and
// hold up everyone else using the mailbox. The object only keeps the records.
export function createMailboxImports(
  bucket: R2Bucket,
  stub: DurableObjectStub<Mailbox>,
  mailboxId: MailboxId,
): MailboxImports {
  const viewOf = async (jobId: string) =>
    (await stub.importJob(jobId)) as ImportJobView | null;

  return {
    async status() {
      const jobs = (await stub.importJobs(JOBS_SHOWN)) as ImportJobView[];
      const latest = jobs[0];
      return {
        jobs,
        unreadable: latest
          ? ((await stub.importUnreadable(latest.id)) as UnreadableItem[])
          : [],
      };
    },

    async start(input) {
      const file = readFile(input);
      if ("ok" in file) return file;
      const busy = refuse(
        409,
        "This mailbox already has an import in progress. Wait for it to finish, or cancel it.",
      );
      if (await stub.hasActiveImport()) return busy;

      const id = crypto.randomUUID();
      const upload = await bucket.createMultipartUpload(
        importFileKey(mailboxId, id),
      );
      const job: NewImportJob = {
        ...file,
        id,
        mailboxId,
        uploadId: upload.uploadId,
      };
      const created = (await stub.createImportJob(job)) as {
        status: "created" | "busy";
        job: ImportJobView;
      };
      if (created.status === "busy") {
        await upload.abort();
        return busy;
      }
      return { ok: true, value: created.job };
    },

    async putPart(jobId, partNumber, body) {
      const plan = (await stub.importPartPlan(jobId, partNumber)) as PartPlan;
      switch (plan.status) {
        case "unknownJob":
          return NO_SUCH_IMPORT;
        case "notUploading":
          return UPLOAD_OVER;
        case "badPartNumber":
          return refuse(400, "This file doesn't have a part with that number.");
        case "ok":
          break;
      }
      const wrongSize = refuse(
        400,
        `This part of the file must be exactly ${plan.expectedBytes} bytes.`,
      );
      if (body.declaredBytes === null) {
        return refuse(
          411,
          "We need to know the size of this part of the file.",
        );
      }
      if (body.declaredBytes !== plan.expectedBytes) return wrongSize;
      const bytes = await body.read(plan.expectedBytes);
      if (bytes?.byteLength !== plan.expectedBytes) return wrongSize;

      try {
        const part = await bucket
          .resumeMultipartUpload(plan.key, plan.uploadId)
          .uploadPart(partNumber, bytes);
        await stub.recordImportPart(jobId, partNumber, part.etag);
        return { ok: true, value: null };
      } catch (error) {
        if (isUploadGone(error)) return UPLOAD_OVER;
        throw error;
      }
    },

    // Safe to repeat. A crash after R2 finished the file leaves the object in place,
    // so a repeat finds it and only has to record that the upload is over.
    async finishUpload(jobId) {
      const target = (await stub.importUploadTarget(jobId)) as {
        state: ImportJobView["state"];
        key: string;
        uploadId: string | null;
        size: number;
      } | null;
      if (!target) return NO_SUCH_IMPORT;
      if (target.state !== "uploading") {
        return { ok: true, value: (await viewOf(jobId))! };
      }

      let size = (await bucket.head(target.key))?.size ?? null;
      if (size === null) {
        const parts = (await stub.importParts(jobId)) as {
          partNumber: number;
          etag: string;
        }[];
        const view = (await viewOf(jobId))!;
        if (parts.length !== view.partCount) {
          return refuse(
            409,
            "Some of the file hasn't arrived yet. Keep this page open to finish sending it.",
          );
        }
        try {
          const object = await bucket
            .resumeMultipartUpload(target.key, target.uploadId!)
            .complete(parts);
          size = object.size;
        } catch (error) {
          if (isUploadGone(error)) return UPLOAD_OVER;
          throw error;
        }
      }
      if (size !== target.size) {
        await stub.failImportUpload(jobId, "sizeMismatch");
      } else {
        await stub.markImportUploaded(jobId);
      }
      return { ok: true, value: (await viewOf(jobId))! };
    },

    async cancel(jobId) {
      await stub.cancelImportJob(jobId);
      const view = await viewOf(jobId);
      return view ? { ok: true, value: view } : NO_SUCH_IMPORT;
    },
  };
}
