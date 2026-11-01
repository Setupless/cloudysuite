import { NAV_ITEM, NAV_ITEM_ACTIVE } from "@cloudysuite/ui";
import { Badge, Button, Notice, Section, SelectField } from "@cloudysuite/ui";
import {
  IconArrowLeft,
  IconFileImport,
  IconPlayerPlay,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ManagedMailbox } from "./functions";
import {
  IMPORT_FAILURES,
  type ImportJobView,
  type ImportState,
  isActive,
  MAX_FILE_BYTES,
  UNREADABLE_REASONS,
} from "./types";
import type { ImportStatus } from "./uploads";
import {
  cancelJob,
  fingerprintOf,
  readStatus,
  startJob,
  uploadFile,
} from "./upload-client";

const POLL_MS = 2000;

const STATE_LABEL: Record<ImportState, string> = {
  uploading: "Sending the file",
  queued: "Waiting to start",
  running: "Importing",
  done: "Finished",
  failed: "Stopped",
  cancelled: "Cancelled",
};

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

const plural = (count: number, one: string) =>
  `${count.toLocaleString()} ${one}${count === 1 ? "" : "s"}`;

export function ImportNavigation() {
  return (
    <>
      <a href="/" className={NAV_ITEM}>
        <IconArrowLeft size={18} stroke={1.75} aria-hidden />
        Back to mail
      </a>
      <a
        href="/import"
        aria-current="page"
        className={`${NAV_ITEM} ${NAV_ITEM_ACTIVE}`}
      >
        <IconFileImport size={18} stroke={1.75} aria-hidden />
        Import mail
      </a>
    </>
  );
}

function Progress({ label, fraction }: { label: string; fraction: number }) {
  const percent = Math.min(100, Math.floor(fraction * 100));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between gap-3 text-sm">
        <span>{label}</span>
        <span className="text-secondary">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 overflow-hidden rounded-full bg-field"
      >
        <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function FilePicker({
  label,
  onPick,
  disabled,
}: {
  label: string;
  onPick: (file: File | null) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex w-full flex-col gap-1.5 text-left text-sm font-medium">
      {label}
      <input
        type="file"
        accept=".mbox,application/mbox"
        disabled={disabled}
        onChange={(event) => onPick(event.target.files?.[0] ?? null)}
        className="w-full rounded border border-line bg-field px-3 py-2.5 text-base font-normal text-text outline-accent file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-panel file:px-3 file:py-1 file:text-sm file:text-text focus-visible:outline-2"
      />
    </label>
  );
}

function Counts({ job }: { job: ImportJobView }) {
  return (
    <ul className="flex flex-col gap-0.5 text-sm">
      <li>{plural(job.stored, "message")} added to Archive</li>
      {job.duplicates > 0 && (
        <li className="text-secondary">
          {plural(job.duplicates, "message")} skipped because this mailbox
          already has them
        </li>
      )}
      {job.unreadable > 0 && (
        <li className="text-danger">
          {plural(job.unreadable, "message")} we couldn't read
        </li>
      )}
    </ul>
  );
}

function UnreadableList({ status }: { status: ImportStatus }) {
  const job = status.jobs[0];
  if (!job || status.unreadable.length === 0) return null;
  const hidden = job.unreadable - status.unreadable.length;
  return (
    <Section
      title="Messages we couldn't read"
      description="These messages were not imported. Everything else in the file is unaffected."
    >
      <ul className="flex flex-col divide-y divide-line">
        {status.unreadable.map((item) => (
          <li key={item.offset} className="flex flex-col gap-0.5 py-2 text-sm">
            <span className="font-medium">
              {item.hint || "A message with no subject we could read"}
            </span>
            <span className="text-secondary">
              {UNREADABLE_REASONS[item.reason]} ({formatBytes(item.size)})
            </span>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="text-sm text-secondary">
          And {plural(hidden, "more message")} not shown here.
        </p>
      )}
    </Section>
  );
}

type Sending = { partsDone: number; partCount: number };

function ImportPanel({ mailbox }: { mailbox: ManagedMailbox }) {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState<Sending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const next = await readStatus(mailbox.id);
    setStatus(next);
    return next;
  }, [mailbox.id]);

  const job = status?.jobs[0] ?? null;
  const active = job !== null && isActive(job.state);

  useEffect(() => {
    refresh().catch((failure: Error) => setError(failure.message));
  }, [refresh]);

  useEffect(() => {
    if (!active || sending) return;
    const timer = setInterval(() => {
      refresh().catch(() => {
        // The next tick tries again, and the job carries on regardless.
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, sending, refresh]);

  // The pickers remount empty when a job starts or ends, so a file chosen before
  // that must not stay behind to be sent again. An upload already running holds
  // its own copy of the file.
  useEffect(() => {
    setFile(null);
  }, [active]);

  useEffect(() => () => abort.current?.abort(), []);

  async function send(current: ImportJobView, picked: File) {
    const controller = new AbortController();
    abort.current = controller;
    setSending({
      partsDone: current.uploadedParts.length,
      partCount: current.partCount,
    });
    try {
      await uploadFile({
        mailboxId: mailbox.id,
        job: current,
        file: picked,
        signal: controller.signal,
        onProgress: setSending,
      });
    } catch (failure) {
      if (!controller.signal.aborted) setError((failure as Error).message);
    } finally {
      // Stops the other parts in flight, so nothing keeps sending behind an error.
      controller.abort();
      setSending(null);
      abort.current = null;
      await refresh().catch(() => {});
    }
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setError(null);
    if (file.size === 0) {
      setError("This file is empty, so there is nothing to import.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(
        "This file is larger than the 100 GB limit. Split it into smaller files, then import each one.",
      );
      return;
    }
    setBusy(true);
    try {
      const created = await startJob(mailbox.id, {
        fileName: file.name,
        size: file.size,
        fingerprint: await fingerprintOf(file),
      });
      await refresh();
      await send(created, file);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resume(current: ImportJobView) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      if (
        file.size !== current.size ||
        (await fingerprintOf(file)) !== current.fingerprint
      ) {
        setError(
          `That isn't the same file. Pick ${current.fileName} to carry on, or cancel this import.`,
        );
        return;
      }
      const latest = await refresh();
      const fresh = latest.jobs.find(
        (candidate) => candidate.id === current.id,
      );
      if (fresh?.state === "uploading") await send(fresh, file);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(current: ImportJobView) {
    setError(null);
    setBusy(true);
    abort.current?.abort();
    try {
      await cancelJob(mailbox.id, current.id);
      setFile(null);
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return error ? (
      <Notice tone="danger">{error}</Notice>
    ) : (
      <Notice tone="info">Checking this mailbox for imports…</Notice>
    );
  }

  return (
    <>
      {error && <Notice tone="danger">{error}</Notice>}

      {job && active && (
        <Section
          title={job.fileName || "Your file"}
          description={`${formatBytes(job.size)}. ${STATE_LABEL[job.state]}.`}
        >
          {job.state === "uploading" && (
            <>
              <Progress
                label="Sending the file"
                fraction={
                  (sending?.partsDone ?? job.uploadedParts.length) /
                  job.partCount
                }
              />
              {!sending && (
                <>
                  <p className="text-sm text-secondary">
                    Sending stopped before the whole file arrived. Pick the same
                    file and we'll carry on from where it stopped.
                  </p>
                  <FilePicker
                    label={`Pick ${job.fileName} again`}
                    onPick={setFile}
                    disabled={busy}
                  />
                  <div>
                    <Button
                      variant="action"
                      icon={IconPlayerPlay}
                      disabled={!file || busy}
                      onClick={() => resume(job)}
                    >
                      Carry on sending
                    </Button>
                  </div>
                </>
              )}
              {sending && (
                <p className="text-sm text-secondary">
                  Keep this page open until the file has been sent. If it
                  closes, you can pick up where it stopped.
                </p>
              )}
            </>
          )}
          {(job.state === "queued" || job.state === "running") && (
            <>
              <Progress
                label="Importing messages"
                fraction={job.byteOffset / job.size}
              />
              <Counts job={job} />
              <p className="text-sm text-secondary">
                You can close this page. The import carries on, and you can come
                back here to check on it.
              </p>
            </>
          )}
          <div>
            <Button
              variant="danger"
              icon={IconX}
              disabled={busy && !sending}
              onClick={() => cancel(job)}
            >
              Cancel import
            </Button>
          </div>
          {job.state !== "uploading" && (
            <p className="text-sm text-secondary">
              If you cancel, messages already imported stay in Archive.
            </p>
          )}
        </Section>
      )}

      {job && !active && (
        <Section
          title={job.fileName || "Your file"}
          description={STATE_LABEL[job.state]}
        >
          {job.state === "done" && (
            <Notice tone="success">
              The import has finished. Find your messages in Archive.
            </Notice>
          )}
          {job.failure && (
            <Notice tone="danger">{IMPORT_FAILURES[job.failure]}</Notice>
          )}
          {job.state === "cancelled" && (
            <Notice tone="info">
              You cancelled this import. Messages already imported stay in
              Archive.
            </Notice>
          )}
          <Counts job={job} />
        </Section>
      )}

      <UnreadableList status={status} />

      {!active && (
        <Section
          title={job ? "Import another file" : "Choose a file"}
          description="Use an .mbox file, such as the mail file in a Google Takeout export. The limit is 100 GB."
        >
          <form className="flex flex-col gap-3" onSubmit={start}>
            <FilePicker
              label="Your .mbox file"
              onPick={setFile}
              disabled={busy}
            />
            <div>
              <Button
                type="submit"
                variant="action"
                icon={IconUpload}
                disabled={!file || busy}
              >
                Start import
              </Button>
            </div>
          </form>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-secondary">
            <li>
              Messages go to Archive, marked as read, with their original dates.
            </li>
            <li>
              Rules, spam filtering, and notifications don't run on imported
              mail.
            </li>
            <li>
              Gmail labels aren't brought across yet, so messages won't keep
              them.
            </li>
            <li>
              Importing the same file twice is safe. Messages already here are
              skipped.
            </li>
          </ul>
        </Section>
      )}
    </>
  );
}

export function ImportPage({
  mailboxes,
  preferredMailboxId,
}: {
  mailboxes: ManagedMailbox[];
  preferredMailboxId?: string | undefined;
}) {
  const [mailboxId, setMailboxId] = useState(
    (
      mailboxes.find((candidate) => candidate.id === preferredMailboxId) ??
      mailboxes[0]
    )?.id ?? null,
  );
  const mailbox = mailboxes.find((candidate) => candidate.id === mailboxId);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Import mail</h1>
        <p className="text-secondary">
          Bring your old mail with you from another service.
        </p>
      </header>
      {mailboxes.length === 0 && (
        <Notice tone="info">
          Only a mailbox's manager can import mail into it, and you don't manage
          a mailbox. Ask your admin to make you a manager.
        </Notice>
      )}
      {mailboxes.length > 1 && (
        <SelectField
          label="Mailbox to import into"
          value={mailboxId ?? ""}
          onChange={(event) => setMailboxId(event.target.value)}
        >
          {mailboxes.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </SelectField>
      )}
      {mailboxes.length === 1 && mailbox && (
        <p className="flex items-center gap-2 text-sm">
          Importing into <Badge>{mailbox.name}</Badge>
        </p>
      )}
      {mailbox && <ImportPanel key={mailbox.id} mailbox={mailbox} />}
    </div>
  );
}
