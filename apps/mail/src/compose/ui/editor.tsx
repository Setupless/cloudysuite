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
import { safeFileName } from "@cloudysuite/transfer";
import type { SenderFacts } from "../addresses";
import { useOffline } from "../../pwa/connectivity";
import { forgetKeptDraft, keepDraft, keepNote } from "../../pwa/device-store";
import {
  DRAFT_KEPT_AFTER_FAILURE,
  isOffline,
  OFFLINE_ACTION_REFUSED,
  OFFLINE_DRAFT_KEPT,
  OFFLINE_DRAFT_NOT_SAVED,
  OFFLINE_SEND_REFUSED,
} from "../../pwa/saved-mail";
import { call, callAction, MailFailure } from "../../queries";
import type { Address, MailboxId } from "../../types";
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
import { isLeftOut, keptCopyId, leftOutOf, leftOutText } from "../kept";
import {
  type DraftContent,
  type DraftForEditor,
  fitsSendLimit,
  MAX_ATTACHMENTS,
  type OutgoingId,
  type OutgoingAttachment,
  type SaveResult,
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
import { deviceQuoteHtml } from "./device-html";
import { keptDraftsQuery } from "./kept-drafts";
import { RecipientField } from "./recipient-field";
import { RichText } from "./rich-text";

const AUTOSAVE_MS = 1_200;
// Offline there's no request to spare, and a closed tab must not lose the last words.
const OFFLINE_KEEP_MS = 150;
// Leaves the browser's few connections free for autosave and the mailbox.
const PARALLEL_UPLOADS = 3;
const LOCKED_NOTICE =
  "This message has already gone, or someone else has sent it, so your changes can't join it. They're kept on this device.";
const LOCKED_KEPT_TOAST =
  "This message has already gone, so your changes will go to Drafts as a new draft.";

type Loaded = {
  draft: DraftForEditor | null;
  quoteHtml: string | null;
  notice: string | null;
};

const EMPTY: Loaded = { draft: null, quoteHtml: null, notice: null };

// The revision makes this give way if a colleague has started on the draft from Drafts.
const discardUntouched = (
  mailboxId: MailboxId,
  id: OutgoingId,
  revision: number | undefined,
) =>
  call(() =>
    discardOutgoing({ data: { mailboxId, id, onlyAtRevision: revision } }),
  ).catch(() => {});

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
  const {
    mailboxId,
    userId,
    openDraft,
    close: closeSession,
    reopen,
  } = useCompose();
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
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [leftOutNotice, setLeftOutNotice] = useState<string | null>(null);
  const [notThreaded, setNotThreaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [locked, setLocked] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [saved, setSaved] = useState(false);

  const body = useRef<HTMLDivElement>(null);
  // The last save runs as the form unmounts, when the editor element has already gone.
  const lastHtml = useRef(content?.html ?? "");
  const fileInput = useRef<HTMLInputElement>(null);
  const revision = useRef(loaded.draft?.revision ?? 0);
  // Words from this device have never reached the server, so they still need saving.
  const dirty = useRef(session.kind === "kept");
  // Whether the latest words are on this device, and which copy there is this editor's
  // to forget. A later copy may be another tab's.
  const keptHere = useRef(session.kind === "kept");
  const keptVersion = useRef(session.kind === "kept" ? session.kept.keptAt : 0);
  const keptWords = useRef("");
  const lastSaveError = useRef("");
  const noAccess = useRef(false);
  const lockedNow = useRef(false);
  // What the server may stop holding, leaving a fact on this screen out of date.
  const quoteHeld = useRef(loaded.draft?.quote ?? null);
  const parentHeld = useRef(loaded.draft?.parent ?? null);
  const leftOutFound = useRef(0);
  const mounted = useRef(true);
  const everSaved = useRef(
    loaded.draft !== null &&
      (session.kind === "open" || session.kind === "kept"),
  );
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

  const attachmentsNow = useRef(attachments);
  attachmentsNow.current = attachments;
  const refreshKept = () =>
    void queryClient.invalidateQueries({
      queryKey: keptDraftsQuery(userId).queryKey,
    });
  const composeMode = () =>
    session.kind === "start" ? session.mode : (loaded.draft?.mode ?? "new");
  const keepHere = async (content: DraftContent) => {
    // A new version of the same words could outrun a move to Drafts already under way,
    // and come back as a second draft.
    const words = JSON.stringify(content);
    if (keptHere.current && words === keptWords.current) return;
    const keptAt = Math.max(Date.now(), keptVersion.current + 1);
    try {
      keptHere.current = await keepDraft(userId, {
        id: session.id,
        mailboxId,
        keptAt,
        content,
        revision: revision.current,
        mode: parentHeld.current || !loaded.draft ? composeMode() : "new",
        parent: parentHeld.current,
        quote: quoteHeld.current,
        quoteHtml: quoteHeld.current ? loaded.quoteHtml : null,
        attachments: attachmentsNow.current,
      });
      if (keptHere.current) {
        keptVersion.current = keptAt;
        keptWords.current = words;
      }
    } catch {
      keptHere.current = false;
    }
    refreshKept();
  };
  const forgetHere = async () => {
    keptHere.current = false;
    if (keptVersion.current === 0) return;
    await forgetKeptDraft(userId, session.id, keptVersion.current).catch(
      () => {},
    );
    keptVersion.current = 0;
    refreshKept();
  };
  // The server's draft no longer has everything this screen shows. If the screen has
  // gone, the note waits on this device so the person still finds out.
  const noteLeftOut = async (
    had: OutgoingAttachment[],
    content: DraftContent,
    holds: Extract<SaveResult, { status: "saved" }>["holds"],
  ) => {
    const leftOut = leftOutOf(
      {
        attachments: had,
        quote: quoteHeld.current,
        parent: parentHeld.current,
        mode: composeMode(),
        includeQuote: content.includeQuote,
      },
      holds,
    );
    const lostConversation = !holds.threaded && parentHeld.current !== null;
    if (!holds.quote) quoteHeld.current = null;
    if (!holds.threaded) parentHeld.current = null;
    if (mounted.current && lostConversation) setNotThreaded(true);
    if (!isLeftOut(leftOut)) return;
    leftOutFound.current += 1;
    if (mounted.current) {
      const gone = had.filter((file) => !holds.attachmentIds.includes(file.id));
      setAttachments((current) =>
        current.filter((file) => !gone.some((one) => one.id === file.id)),
      );
      if (leftOut.quote) setIncludeQuote(false);
      setLeftOutNotice(leftOutText(leftOut));
      return;
    }
    await keepNote(userId, {
      id: session.id,
      mailboxId,
      subject: content.subject,
      leftOut,
      changed: null,
    }).catch(() => {});
    refreshKept();
  };

  const flush = useCallback((): Promise<void> => {
    clearTimeout(timer.current);
    if (!dirty.current) return saving.current;
    dirty.current = false;
    const content = read.current();
    saving.current = saving.current.then(async () => {
      // No later save can land. The words wait here for the person to choose.
      if (lockedNow.current) {
        dirty.current = true;
        await keepHere(content);
        return;
      }
      // Files uploaded while this is on its way aren't in what the server answers with.
      const had = attachmentsNow.current;
      try {
        const result = await callAction(() =>
          saveDraft({
            data: {
              mailboxId,
              id: session.id,
              baseRevision: revision.current,
              content,
            },
          }),
        );
        setSaveProblem(null);
        noAccess.current = false;
        if (result.status === "locked") {
          lockedNow.current = true;
          dirty.current = true;
          setLocked(true);
          await keepHere(content);
          return;
        }
        await forgetHere();
        revision.current = result.revision;
        everSaved.current = true;
        setSaved(true);
        if (result.overwrote) {
          setNotice(
            `${result.overwrote} was also working on this draft. Your version is the one saved now.`,
          );
        }
        await noteLeftOut(had, content, result.holds);
      } catch (error) {
        dirty.current = true;
        lastSaveError.current = (error as Error).message;
        await keepHere(content);
        if (error instanceof MailFailure && error.status === 403) {
          noAccess.current = true;
          setSaveProblem(
            `${lastSaveError.current} What you wrote is kept on this device.`,
          );
        }
      }
    });
    return saving.current;
  }, [mailboxId, session.id]);

  const touched = useCallback(() => {
    if (body.current) lastHtml.current = body.current.innerHTML;
    dirty.current = true;
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => void flush(),
      isOffline() || lockedNow.current ? OFFLINE_KEEP_MS : AUTOSAVE_MS,
    );
  }, [flush]);

  // What couldn't be saved offline goes as soon as it can. This is only ever the draft
  // in front of the person, never a send.
  const offline = useOffline();
  useEffect(() => {
    if (!offline && dirty.current) void flush();
  }, [offline, flush]);

  // A later render holds the fields a save should read, so it runs after they settle.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    touched();
  }, [from, to, cc, bcc, subject, includeQuote, touched]);

  const refreshList = () =>
    void queryClient.invalidateQueries({
      queryKey: composeKeys.outgoing(mailboxId),
    });

  const isUntouchedReply = () =>
    session.kind === "start" &&
    !everSaved.current &&
    !dirty.current &&
    uploading.length === 0 &&
    attachments.length === (loaded.draft?.attachments.length ?? 0);
  // The unmount below would otherwise see the first render's files.
  const untouchedNow = useRef(isUntouchedReply);
  untouchedNow.current = isUntouchedReply;

  const keptToast = () => {
    if (noAccess.current) {
      return {
        message: `${lastSaveError.current} What you wrote is kept on this device.`,
      };
    }
    return {
      message: isOffline()
        ? OFFLINE_DRAFT_KEPT
        : lockedNow.current
          ? LOCKED_KEPT_TOAST
          : DRAFT_KEPT_AFTER_FAILURE,
      action: { label: "Open", run: () => void reopen(session.id) },
    };
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    const onPageHide = () => void flush();
    document.addEventListener("visibilitychange", onHide);
    addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      removeEventListener("pagehide", onPageHide);
      clearTimeout(timer.current);
      if (leftUnasked.current && untouchedNow.current()) {
        void discardUntouched(
          mailboxId,
          session.id,
          loaded.draft?.revision,
        ).then(refreshList);
        return;
      }
      const hadSomething = dirty.current || everSaved.current;
      void flush().then(() => {
        if (!leftUnasked.current) return;
        if (dirty.current) {
          toast(
            keptHere.current
              ? keptToast()
              : {
                  tone: "danger",
                  message:
                    "We couldn't save your latest changes, so they may be lost. Check your connection, then look in Drafts.",
                },
          );
        } else if (hadSomething && !lockedNow.current) {
          toast({
            message: "Saved to Drafts.",
            action: { label: "Open", run: () => void reopen(session.id) },
          });
        }
      });
    };
  }, [flush]);

  const closeEditor = async () => {
    if (isUntouchedReply()) {
      await discardUntouched(mailboxId, session.id, loaded.draft?.revision);
      close();
      return;
    }
    const hadSomething =
      dirty.current || everSaved.current || attachments.length > 0;
    const lockedBefore = lockedNow.current;
    const leftOutBefore = leftOutFound.current;
    await flush();
    // Something the person needs to read has only just appeared.
    if (lockedNow.current && !lockedBefore) return;
    if (leftOutFound.current !== leftOutBefore) return;
    if (dirty.current && keptHere.current) {
      close();
      toast(keptToast());
      return;
    }
    if (dirty.current) {
      setSaveProblem(
        isOffline()
          ? OFFLINE_DRAFT_NOT_SAVED
          : `We couldn't save this draft, so it's still open here. ${lastSaveError.current}`,
      );
      return;
    }
    close();
    if (hadSomething && session.kind !== "open" && !lockedNow.current)
      toast({ message: "Saved to Drafts." });
  };

  const discard = async () => {
    clearTimeout(timer.current);
    dirty.current = false;
    await saving.current;
    try {
      await callAction(() =>
        discardOutgoing({ data: { mailboxId, id: session.id } }),
      );
      await forgetHere();
      close();
      toast({ message: "Draft discarded." });
    } catch (error) {
      dirty.current = true;
      setProblem((error as Error).message);
    }
  };

  const saveAsNewDraft = async () => {
    await flush();
    const content = read.current();
    try {
      const id = await keptCopyId(session.id, keptVersion.current);
      await callAction(() =>
        saveDraft({
          data: { mailboxId, id, baseRevision: 0, content },
        }),
      );
      const leftOut = leftOutOf(
        {
          attachments: attachmentsNow.current,
          quote: quoteHeld.current,
          parent: parentHeld.current,
          mode: composeMode(),
          includeQuote: content.includeQuote,
        },
        { attachmentIds: [], quote: false, threaded: false },
      );
      await forgetHere();
      dirty.current = false;
      leftUnasked.current = false;
      refreshList();
      openDraft(
        id,
        isLeftOut(leftOut) ? { warning: leftOutText(leftOut) } : {},
      );
      toast({ message: "Saved as a new draft." });
    } catch (error) {
      setSaveProblem(
        `We couldn't save a new draft, so your words are still here and on this device. ${(error as Error).message}`,
      );
    }
  };

  const send = async () => {
    if (sending || uploading.length > 0) {
      if (uploading.length > 0)
        setProblem("Wait for your files to finish uploading.");
      return;
    }
    if (isOffline()) {
      setProblem(OFFLINE_SEND_REFUSED);
      return;
    }
    setProblem(null);
    setSending(true);
    // Moving away mid-send must not count this as a reply nobody wrote.
    everSaved.current = true;
    // What was on screen may have gone from the server's draft, and sending without it
    // would be silent. A message with only words has nothing to lose this way.
    const couldLoseSomething =
      attachments.length > 0 || parentHeld.current || quoteHeld.current;
    if (couldLoseSomething) {
      const leftOutBefore = leftOutFound.current;
      dirty.current = true;
      await flush();
      if (dirty.current || leftOutFound.current !== leftOutBefore) {
        setSending(false);
        return;
      }
    }
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
      await forgetHere();
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
    if (isOffline()) {
      setProblem(OFFLINE_ACTION_REFUSED);
      return;
    }
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
      quoteBytes: includeQuote ? (quoteHeld.current?.bytes ?? 0) : 0,
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
      await callAction(() =>
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
    if (event.nativeEvent.isComposing) return;
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
  const title = notThreaded
    ? "New message"
    : session.kind === "start"
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
          {saved
            ? "Saved"
            : (offline || locked) && dirty.current
              ? "Kept on this device"
              : ""}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {session.kind === "open" && session.warning && (
          <Notice tone="danger">{session.warning}</Notice>
        )}
        {notice && <Notice tone="info">{notice}</Notice>}
        {leftOutNotice && <Notice tone="danger">{leftOutNotice}</Notice>}
        {locked && (
          <Notice tone="danger">
            {LOCKED_NOTICE}{" "}
            <button
              type="button"
              onClick={() => void saveAsNewDraft()}
              className="cursor-pointer font-medium underline outline-accent focus-visible:outline-2"
            >
              Save as a new draft
            </button>
          </Notice>
        )}
        {offline && (
          <Notice tone="info">
            You're offline. You can keep writing. This message stays on this
            device, goes to Drafts when you reconnect, and can't be sent until
            then.
          </Notice>
        )}

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
        {includeQuote && loaded.quoteHtml && quoteHeld.current && (
          <QuotedOriginal
            html={loaded.quoteHtml}
            designed={quoteHeld.current.designed}
            startOpen={loaded.draft?.mode === "forward"}
            onRemove={() => setIncludeQuote(false)}
          />
        )}
        {includeQuote && !loaded.quoteHtml && quoteHeld.current && (
          <p className="border-t border-line py-2 text-xs text-secondary">
            The original message will go with this, but we can't show it here.
          </p>
        )}
      </div>

      {saveProblem && <Notice tone="danger">{saveProblem}</Notice>}
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
  const [loaded, setLoaded] = useState<Loaded | null>(() => {
    if (session.kind === "new") return EMPTY;
    if (session.kind === "kept") {
      return {
        ...EMPTY,
        draft: session.kept,
        quoteHtml:
          session.kept.quoteHtml === null
            ? null
            : deviceQuoteHtml(session.kept.quoteHtml),
      };
    }
    return null;
  });
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (session.kind === "new" || session.kind === "kept") return;
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
        // The person moved away before the reply even appeared.
        else if (session.kind === "start")
          void discardUntouched(mailboxId, session.id, result.draft.revision);
      })
      .catch((error: Error) => {
        if (!ignore) setFailed(error.message);
      });
    return () => {
      ignore = true;
    };
    // The session's id says everything that matters about it.
  }, [mailboxId, session.id, attempt]);

  // Words kept on this device must open with no connection, so they bring their own From.
  const addresses =
    sender.data?.addresses ??
    (session.kind === "kept" && session.kept.content.from
      ? [{ address: session.kept.content.from, kind: "primary" as const }]
      : null);
  if (failed || (sender.isError && !addresses)) {
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
  if (!loaded || !addresses) {
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
      addresses={addresses}
    />
  );
}
