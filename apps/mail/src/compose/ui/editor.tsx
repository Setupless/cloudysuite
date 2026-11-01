import { Button, Modal, Notice } from "@cloudysuite/ui";
import {
  IconArrowLeft,
  IconChevronDown,
  IconPaperclip,
  IconSend,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { safeFileName } from "../../attachment-headers";
import type { SenderFacts } from "../addresses";
import { call } from "../../queries";
import type { Address } from "../../types";
import { EmailFrame } from "../../ui/email-frame";
import { formatSize } from "../../ui/format";
import { FailureNotice } from "../../ui/states";
import { useToast } from "../../ui/toast";
import {
  discardOutgoing,
  getDraft,
  removeOutgoingAttachment,
  saveDraft,
  sendDraft,
  startDraft,
} from "../functions";
import {
  type DraftContent,
  fitsSendLimit,
  MAX_ATTACHMENTS,
  type OutgoingAttachment,
  type OutgoingDetail,
  TOO_LARGE_TEXT,
  TOO_MANY_ATTACHMENTS_TEXT,
} from "../types";
import { type ComposeSession, useCompose } from "./compose-context";
import {
  composeContextQuery,
  composeKeys,
  UploadRefused,
  uploadAttachment,
} from "./queries";
import { RecipientField } from "./recipient-field";
import { RichText } from "./rich-text";

const AUTOSAVE_MS = 1_200;
// Leaves the browser's few connections free for autosave and the mailbox.
const PARALLEL_UPLOADS = 3;
const LOCKED_NOTICE =
  "This message has already gone, or someone else has sent it. Your changes here weren't saved.";

type Loaded = {
  draft: OutgoingDetail | null;
  quoteHtml: string | null;
  notice: string | null;
};

const EMPTY: Loaded = { draft: null, quoteHtml: null, notice: null };

function QuotedOriginal({
  html,
  designed,
  startOpen,
  onRemove,
}: {
  html: string;
  designed: boolean;
  startOpen: boolean;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <section
      aria-label="Quoted message"
      className="flex flex-col gap-2 border-t border-line py-2"
    >
      <div className="flex flex-wrap items-center gap-3 text-xs text-secondary">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex cursor-pointer items-center gap-1 outline-accent focus-visible:outline-2"
        >
          <IconChevronDown
            size={14}
            stroke={1.75}
            className={open ? "rotate-180" : ""}
            aria-hidden
          />
          {open ? "Hide the original message" : "Show the original message"}
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="cursor-pointer underline outline-accent focus-visible:outline-2"
        >
          Leave it out
        </button>
      </div>
      {/* The same sandboxed frame as reading. A stranger's markup never joins the page. */}
      {open && (
        <EmailFrame
          title="The original message"
          html={html}
          designed={designed}
          showRemoteImages={false}
        />
      )}
    </section>
  );
}

function AttachmentList({
  attachments,
  uploading,
  onRemove,
}: {
  attachments: OutgoingAttachment[];
  uploading: string[];
  onRemove: (attachment: OutgoingAttachment) => void;
}) {
  if (attachments.length === 0 && uploading.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-2 py-2">
      {attachments.map((attachment) => (
        <li
          key={attachment.id}
          className="flex max-w-full items-center gap-2 rounded border border-line py-1 pr-1 pl-2.5 text-sm"
        >
          <IconPaperclip
            size={14}
            stroke={1.75}
            className="flex-none text-secondary"
            aria-hidden
          />
          <span className="min-w-0 truncate">
            {safeFileName(attachment.filename, "Attachment")}
          </span>
          <span className="flex-none text-xs text-secondary">
            {formatSize(attachment.size)}
          </span>
          <button
            type="button"
            aria-label={`Remove ${attachment.filename}`}
            onClick={() => onRemove(attachment)}
            className="flex size-6 flex-none cursor-pointer items-center justify-center rounded text-secondary outline-accent hover:bg-field focus-visible:outline-2"
          >
            <IconX size={14} stroke={1.75} aria-hidden />
          </button>
        </li>
      ))}
      {uploading.map((name, index) => (
        <li
          key={`${name}-${index}`}
          className="flex max-w-full items-center gap-2 rounded border border-line px-2.5 py-1 text-sm text-secondary"
        >
          <IconPaperclip
            size={14}
            stroke={1.75}
            className="flex-none"
            aria-hidden
          />
          <span className="min-w-0 truncate">{name}</span>
          <span className="flex-none text-xs">Uploading…</span>
        </li>
      ))}
    </ul>
  );
}

function EditorForm({
  session,
  loaded,
  addresses,
}: {
  session: ComposeSession;
  loaded: Loaded;
  addresses: SenderFacts["addresses"];
}) {
  const { mailboxId, close: closeSession, openDraft } = useCompose();
  const queryClient = useQueryClient();
  const toast = useToast();
  const content = loaded.draft?.content;

  const [from, setFrom] = useState(content?.from ?? "");
  const [to, setTo] = useState<Address[]>(content?.to ?? []);
  const [cc, setCc] = useState<Address[]>(content?.cc ?? []);
  const [bcc, setBcc] = useState<Address[]>(content?.bcc ?? []);
  const [showCopies, setShowCopies] = useState(
    Boolean(content?.cc.length || content?.bcc.length),
  );
  const [subject, setSubject] = useState(content?.subject ?? "");
  const [includeQuote, setIncludeQuote] = useState(
    content?.includeQuote ?? false,
  );
  const [attachments, setAttachments] = useState(
    loaded.draft?.attachments ?? [],
  );
  const [uploading, setUploading] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(loaded.notice);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [locked, setLocked] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [saved, setSaved] = useState(false);

  const body = useRef<HTMLDivElement>(null);
  // The last save runs as the form unmounts, when the editor element has already gone.
  const lastHtml = useRef(content?.html ?? "");
  const fileInput = useRef<HTMLInputElement>(null);
  const revision = useRef(loaded.draft?.revision ?? 0);
  const dirty = useRef(false);
  const everSaved = useRef(loaded.draft !== null && session.kind === "open");
  const saving = useRef<Promise<void>>(Promise.resolve());
  // Moving to another list or conversation takes the editor away without a word.
  const leftUnasked = useRef(true);
  const close = () => {
    leftUnasked.current = false;
    closeSession();
  };
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // A reopened message's address may have left this mailbox since it was written.
  const effectiveFrom = addresses.some(
    ({ address }) => address === from.toLowerCase(),
  )
    ? from
    : (addresses[0]?.address ?? "");

  const read = useRef<() => DraftContent>(() => {
    throw new Error("The editor hasn't rendered yet.");
  });
  read.current = () => ({
    from: effectiveFrom,
    to,
    cc,
    bcc,
    subject,
    html: body.current?.innerHTML ?? lastHtml.current,
    includeQuote,
  });

  const flush = useCallback((): Promise<void> => {
    clearTimeout(timer.current);
    if (!dirty.current) return saving.current;
    dirty.current = false;
    const content = read.current();
    saving.current = saving.current.then(async () => {
      try {
        const result = await call(() =>
          saveDraft({
            data: {
              mailboxId,
              id: session.id,
              baseRevision: revision.current,
              content,
            },
          }),
        );
        if (result.status === "locked") {
          setLocked(true);
          setNotice(LOCKED_NOTICE);
          return;
        }
        revision.current = result.revision;
        everSaved.current = true;
        setSaved(true);
        if (result.overwrote) {
          setNotice(
            `${result.overwrote} was also working on this draft. Your version is the one saved now.`,
          );
        }
      } catch {
        dirty.current = true;
      }
    });
    return saving.current;
  }, [mailboxId, session.id]);

  const touched = useCallback(() => {
    if (body.current) lastHtml.current = body.current.innerHTML;
    dirty.current = true;
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  }, [flush]);

  // A later render holds the fields a save should read, so it runs after they settle.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    touched();
  }, [from, to, cc, bcc, subject, includeQuote, touched]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      clearTimeout(timer.current);
      const hadSomething = dirty.current || everSaved.current;
      void flush();
      if (leftUnasked.current && hadSomething) {
        toast({
          message: "Saved to Drafts.",
          action: { label: "Open", run: () => openDraft(session.id) },
        });
      }
    };
  }, [flush]);

  const refreshList = () =>
    void queryClient.invalidateQueries({
      queryKey: composeKeys.outgoing(mailboxId),
    });

  const isUntouchedReply = () =>
    session.kind === "start" &&
    !everSaved.current &&
    !dirty.current &&
    attachments.length === (loaded.draft?.attachments.length ?? 0);

  const closeEditor = async () => {
    if (isUntouchedReply()) {
      await call(() =>
        discardOutgoing({ data: { mailboxId, id: session.id } }),
      ).catch(() => {});
      close();
      return;
    }
    const hadSomething =
      dirty.current || everSaved.current || attachments.length > 0;
    await flush();
    close();
    if (hadSomething && session.kind !== "open")
      toast({ message: "Saved to Drafts." });
  };

  const discard = async () => {
    clearTimeout(timer.current);
    dirty.current = false;
    await saving.current;
    try {
      await call(() =>
        discardOutgoing({ data: { mailboxId, id: session.id } }),
      );
      close();
      toast({ message: "Draft discarded." });
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  const send = async () => {
    if (sending || uploading.length > 0) {
      if (uploading.length > 0)
        setProblem("Wait for your files to finish uploading.");
      return;
    }
    setProblem(null);
    setSending(true);
    clearTimeout(timer.current);
    dirty.current = false;
    await saving.current;
    try {
      await call(() =>
        sendDraft({
          data: {
            mailboxId,
            id: session.id,
            baseRevision: revision.current,
            content: read.current(),
          },
        }),
      );
      close();
      refreshList();
    } catch (error) {
      dirty.current = true;
      setSending(false);
      setProblem((error as Error).message);
    }
  };

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setProblem(null);
    if (
      attachments.length + uploading.length + files.length >
      MAX_ATTACHMENTS
    ) {
      setProblem(TOO_MANY_ATTACHMENTS_TEXT);
      return;
    }
    const fits = fitsSendLimit({
      bodyBytes: body.current?.innerHTML.length ?? 0,
      quoteBytes: includeQuote ? (loaded.draft?.quote?.bytes ?? 0) : 0,
      attachmentSizes: [
        ...attachments.map((file) => file.size),
        ...files.map((file) => file.size),
      ],
    });
    if (!fits) {
      setProblem(TOO_LARGE_TEXT);
      return;
    }
    setUploading((names) => [...names, ...files.map((file) => file.name)]);
    const queue = [...files];
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const { name } = file;
        try {
          const attachment = await uploadAttachment(
            mailboxId,
            session.id,
            file,
          );
          everSaved.current = true;
          setAttachments((current) => [...current, attachment]);
        } catch (error) {
          setProblem(
            error instanceof UploadRefused
              ? error.message
              : "We couldn't attach that file. Try again.",
          );
        } finally {
          setUploading((names) => {
            const index = names.indexOf(name);
            return names.filter((_, position) => position !== index);
          });
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL_UPLOADS }, worker));
  };

  const removeAttachment = async (attachment: OutgoingAttachment) => {
    setAttachments((current) =>
      current.filter((one) => one.id !== attachment.id),
    );
    try {
      await call(() =>
        removeOutgoingAttachment({
          data: { mailboxId, id: session.id, attachmentId: attachment.id },
        }),
      );
    } catch (error) {
      setAttachments((current) => [...current, attachment]);
      setProblem((error as Error).message);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void send();
    } else if (event.key === "Escape" && !confirmingDiscard) {
      event.preventDefault();
      void closeEditor();
    }
  };

  const onDrop = (event: DragEvent) => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    void addFiles([...event.dataTransfer.files]);
  };

  const isPanel = session.host === "panel";
  const replying = session.kind === "start" || loaded.draft?.parent != null;
  const title =
    session.kind === "start"
      ? { reply: "Reply", replyAll: "Reply all", forward: "Forward" }[
          session.mode
        ]
      : loaded.draft?.mode === "forward"
        ? "Forward"
        : replying
          ? "Reply"
          : "New message";

  return (
    <form
      aria-label={title}
      onKeyDown={onKeyDown}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      className={
        isPanel
          ? "flex h-full min-h-0 flex-col bg-panel px-4 py-3 lg:px-6"
          : "flex flex-col rounded border border-line bg-panel px-3 py-2"
      }
    >
      <header className="flex flex-none items-center gap-2 pb-1">
        <button
          type="button"
          aria-label="Close and keep as a draft"
          title="Close and keep as a draft"
          onClick={() => void closeEditor()}
          className="flex size-8 flex-none cursor-pointer items-center justify-center rounded text-secondary outline-accent hover:bg-field focus-visible:outline-2"
        >
          {isPanel ? (
            <>
              <IconArrowLeft
                size={20}
                stroke={1.75}
                className="lg:hidden"
                aria-hidden
              />
              <IconX
                size={18}
                stroke={1.75}
                className="max-lg:hidden"
                aria-hidden
              />
            </>
          ) : (
            <IconX size={18} stroke={1.75} aria-hidden />
          )}
        </button>
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
          {title}
        </h2>
        <span role="status" className="flex-none text-xs text-secondary">
          {saved ? "Saved" : ""}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {session.kind === "open" && session.warning && (
          <Notice tone="danger">{session.warning}</Notice>
        )}
        {notice && <Notice tone="info">{notice}</Notice>}

        <div className="flex items-center gap-2 border-b border-line py-1.5">
          <label
            htmlFor={`${session.id}-from`}
            className="w-10 flex-none text-sm text-secondary"
          >
            From
          </label>
          {addresses.length > 1 ? (
            <select
              id={`${session.id}-from`}
              value={effectiveFrom}
              onChange={(event) => setFrom(event.target.value)}
              className="min-w-0 flex-1 cursor-pointer rounded bg-transparent py-1 text-sm text-text outline-accent focus-visible:outline-2"
            >
              {addresses.map(({ address }) => (
                <option key={address} value={address}>
                  {address}
                </option>
              ))}
            </select>
          ) : (
            <output
              id={`${session.id}-from`}
              className="min-w-0 flex-1 truncate py-1 text-sm"
            >
              {effectiveFrom}
            </output>
          )}
          {!showCopies && (
            <button
              type="button"
              onClick={() => setShowCopies(true)}
              className="flex-none cursor-pointer text-sm text-secondary outline-accent hover:text-text focus-visible:outline-2"
            >
              Cc and Bcc
            </button>
          )}
        </div>
        <RecipientField
          label="To"
          mailboxId={mailboxId}
          people={to}
          onChange={setTo}
          autoFocus={session.kind === "new" || loaded.draft?.mode === "forward"}
        />
        {showCopies && (
          <>
            <RecipientField
              label="Cc"
              mailboxId={mailboxId}
              people={cc}
              onChange={setCc}
            />
            <RecipientField
              label="Bcc"
              mailboxId={mailboxId}
              people={bcc}
              onChange={setBcc}
            />
          </>
        )}
        <div className="flex items-center gap-2 border-b border-line py-1.5">
          <label
            htmlFor={`${session.id}-subject`}
            className="w-14 flex-none text-sm text-secondary"
          >
            Subject
          </label>
          <input
            id={`${session.id}-subject`}
            type="text"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            className="min-w-0 flex-1 bg-transparent py-1 text-sm text-text outline-none"
          />
        </div>

        <RichText
          editor={body}
          initialHtml={content?.html ?? ""}
          onInput={touched}
          autoFocus={session.kind !== "new" && loaded.draft?.mode !== "forward"}
        />

        <AttachmentList
          attachments={attachments}
          uploading={uploading}
          onRemove={(attachment) => void removeAttachment(attachment)}
        />
        {includeQuote && loaded.quoteHtml && (
          <QuotedOriginal
            html={loaded.quoteHtml}
            designed={loaded.draft?.quote?.designed ?? false}
            startOpen={loaded.draft?.mode === "forward"}
            onRemove={() => setIncludeQuote(false)}
          />
        )}
      </div>

      {problem && <Notice tone="danger">{problem}</Notice>}
      <footer className="flex flex-none flex-wrap items-center gap-2 pt-2">
        <Button
          variant="action"
          icon={IconSend}
          disabled={sending || locked}
          onClick={() => void send()}
        >
          {sending ? "Sending…" : "Send"}
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Attach files"
          onChange={(event) => {
            void addFiles([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          title="Attach files"
          aria-label="Attach files"
          onClick={() => fileInput.current?.click()}
          className="flex size-9 cursor-pointer items-center justify-center rounded text-secondary outline-accent hover:bg-field focus-visible:outline-2"
        >
          <IconPaperclip size={18} stroke={1.75} aria-hidden />
        </button>
        <span className="flex-1" />
        <button
          type="button"
          title="Discard draft"
          aria-label="Discard draft"
          onClick={() => setConfirmingDiscard(true)}
          className="flex size-9 cursor-pointer items-center justify-center rounded text-secondary outline-accent hover:bg-field hover:text-danger focus-visible:outline-2"
        >
          <IconTrash size={18} stroke={1.75} aria-hidden />
        </button>
      </footer>
      {confirmingDiscard && (
        <Modal
          title="Discard this draft?"
          onClose={() => setConfirmingDiscard(false)}
        >
          <p className="text-sm text-secondary">
            You can't get it back after this.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="quiet"
              autoFocus
              onClick={() => setConfirmingDiscard(false)}
            >
              Keep it
            </Button>
            <Button variant="danger" onClick={() => void discard()}>
              Discard
            </Button>
          </div>
        </Modal>
      )}
    </form>
  );
}

// Everything the form needs comes from the server first, so it can start from a draft
// someone left half done, on this device or another.
export function ComposeEditor({ session }: { session: ComposeSession }) {
  const { mailboxId } = useCompose();
  // A form with no From address could only be refused, so it waits for the choices.
  const sender = useQuery(composeContextQuery(mailboxId));
  const [loaded, setLoaded] = useState<Loaded | null>(
    session.kind === "new" ? EMPTY : null,
  );
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (session.kind === "new") return;
    let ignore = false;
    const load =
      session.kind === "start"
        ? call(() =>
            startDraft({
              data: {
                mailboxId,
                id: session.id,
                mode: session.mode,
                parentMessageId: session.parentMessageId,
              },
            }),
          )
        : call(() => getDraft({ data: { mailboxId, id: session.id } })).then(
            (result) => ({ ...result, notice: null }),
          );
    load
      .then((result) => {
        if (!ignore) setLoaded(result);
      })
      .catch((error: Error) => {
        if (!ignore) setFailed(error.message);
      });
    return () => {
      ignore = true;
    };
    // The session's id says everything that matters about it.
  }, [mailboxId, session.id, attempt]);

  if (failed || sender.isError) {
    return (
      <FailureNotice
        message={failed ?? sender.error?.message ?? ""}
        onRetry={() => {
          setFailed(null);
          setAttempt(attempt + 1);
          if (sender.isError) void sender.refetch();
        }}
      />
    );
  }
  if (!loaded || !sender.data) {
    return (
      <div aria-hidden className="flex animate-pulse flex-col gap-3 px-6 py-5">
        <div className="h-4 w-1/3 rounded bg-field" />
        <div className="h-4 w-2/3 rounded bg-field" />
        <div className="h-24 w-full rounded bg-field" />
      </div>
    );
  }
  return (
    <EditorForm
      key={session.id}
      session={session}
      loaded={loaded}
      addresses={sender.data.addresses}
    />
  );
}
