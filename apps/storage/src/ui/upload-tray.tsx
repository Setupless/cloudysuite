import { IconX } from "@tabler/icons-react";
import { useEffect, useSyncExternalStore } from "react";
import { batchProgress, timeLeftText, type UploadBatch } from "./upload-queue";
import { useUploads } from "./uploads-context";

const CLOSE_AFTER_MS = 6000;
const NOTHING: readonly UploadBatch[] = [];

const fileWord = (count: number) => (count === 1 ? "file" : "files");

function title(batch: UploadBatch): string {
  const { finished, sent, refused } = batchProgress(batch);
  const total = batch.files.length;
  if (!finished) {
    return `Uploading ${total} ${fileWord(total)} to ${batch.name}`;
  }
  return refused.length === 0
    ? `Uploaded ${total} ${fileWord(total)} to ${batch.name}`
    : `Uploaded ${sent} of ${total} ${fileWord(total)} to ${batch.name}`;
}

function BatchCard({ batch }: { batch: UploadBatch }) {
  const uploads = useUploads();
  const { finished, refused, fraction } = batchProgress(batch);

  useEffect(() => {
    if (!finished || refused.length > 0) return;
    const timer = setTimeout(() => uploads.close(batch.id), CLOSE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [finished, refused.length, uploads, batch.id]);

  return (
    <div
      role="status"
      className="rounded border border-line bg-panel p-3 text-[13px] shadow-lg"
    >
      <div className="flex items-start gap-2">
        <strong className="min-w-0 flex-1 font-semibold break-words">
          {title(batch)}
        </strong>
        <button
          type="button"
          aria-label={finished ? "Close" : "Stop uploading"}
          className="flex-none cursor-pointer rounded text-secondary outline-accent hover:text-text focus-visible:outline-2"
          onClick={() => uploads.close(batch.id)}
        >
          <IconX size={15} stroke={1.75} aria-hidden />
        </button>
      </div>
      {!finished && (
        <div className="mt-2 h-[5px] overflow-hidden rounded bg-field">
          <div
            className="h-full bg-accent transition-[width]"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </div>
      )}
      {!finished && (
        <p className="mt-1.5 text-xs text-secondary">
          {batch.waiting === "folderMoving"
            ? "That folder is being moved. The upload will carry on by itself, so keep this page open."
            : batch.waiting === "connection"
              ? "Waiting for your connection. The upload will carry on by itself, so keep this page open."
              : `${timeLeftText(batch, Date.now())} You can keep working. If your connection drops, the upload picks up where it stopped.`}
        </p>
      )}
      {refused.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1 text-xs text-danger">
          {refused.map((file) => (
            <li key={file.id} className="break-words">
              {file.file.name}: {file.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function UploadTray() {
  const uploads = useUploads();
  const batches = useSyncExternalStore(
    uploads.subscribe,
    uploads.snapshot,
    () => NOTHING,
  );
  if (batches.length === 0) return null;
  return (
    <div className="fixed right-3.5 bottom-3.5 z-20 flex w-[290px] flex-col gap-2 max-sm:left-3.5 max-sm:w-auto">
      {batches.map((batch) => (
        <BatchCard key={batch.id} batch={batch} />
      ))}
    </div>
  );
}
