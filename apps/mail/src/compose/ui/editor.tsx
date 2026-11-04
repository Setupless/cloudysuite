import { Button, Modal, Notice, Spinner } from "@cloudysuite/ui";
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
import { holdsSomethingAdded } from "../added";
import { useOffline } from "../../pwa/connectivity";
import {
  forgetKeptDraft,
  getReadyToKeepNow,
  keepDraft,
  keepDraftNow,
  keepNote,
} from "../../pwa/device-store";
import {
  DRAFT_KEPT_AFTER_FAILURE,
  isOffline,
  OFFLINE_ACTION_REFUSED,
  OFFLINE_DRAFT_KEPT,
  OFFLINE_DRAFT_NOT_SAVED,
  OFFLINE_DRAFT_NOT_REMOVED,
  OFFLINE_SEND_REFUSED,
} from "../../pwa/saved-mail";
import { call, callAction, MailFailure } from "../../queries";
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
  prefillDraft,
  sendDraft,
} from "../functions";
import { discardWhenSettled, nothingToDiscard } from "../discard";
import {
  behindText,
  changedText,
  discardBehindText,
  isLeftOut,
  leftOutOf,
  leftOutText,
  sentBesideText,
} from "../kept";
import {
  type DraftChange,
  type DraftContent,
  type DraftForEditor,
  fitsSendLimit,
  isHeld,
  MAX_ATTACHMENTS,
  NOTHING_PREFILLED,
  type OutgoingAttachment,
  type SaveResult,
  startOf,
  TOO_LARGE_TEXT,
  TOO_MANY_ATTACHMENTS_TEXT,
} from "../types";
import { type ComposeSession, useCompose } from "./compose-context";
import {
  composeContextQuery,
  composeKeys,
  DraftMovedOn,
  type UploadedFile,
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
const OPENED_A_COPY =
  "This is a new draft, saved beside one that changed while it was being written. Look in Drafts for the other version.";
const FILE_WENT_WRONG = "We couldn't attach that file. Try again.";
const SAVED_TO_DRAFTS = "Saved to Drafts.";
// However often the draft moves on under a Send, the person's words only need one new draft.
const SEND_TRIES = 3;
const SEND_KEPT_MOVING =
  "Someone keeps changing this draft, so it wasn't sent. Your words are still here. Try again.";
const CHANGED_ELSEWHERE =
  "This draft changed somewhere else while you were clearing it, so it's still in Drafts.";
const DISCARD_UNFINISHED =
  "We couldn't finish discarding this draft. If it's in Drafts, you can discard it there.";

const outlivingThePage = (...[input, init]: Parameters<typeof fetch>) =>
  fetch(input, { ...init, keepalive: true });

type Loaded = {
  draft: DraftForEditor | null;
  quoteHtml: string | null;
  notice: string | null;
};

const EMPTY: Loaded = { draft: null, quoteHtml: null, notice: null };

// What the person asked the editor to do. Only one runs at a time.
type EditorWork = "send" | "close" | "copy" | "discard";
type SaveState = "unsaved" | "saving" | "saved";

// What decides whether a save holds anything new. The address it goes out from and leaving
// out the quote choose among what's there, so they aren't new words.
const wordsOf = ({ to, cc, bcc, subject, html }: DraftContent) =>
  JSON.stringify([to, cc, bcc, subject, html]);

type SaveAim = {
  // Sending or changing files needs this person's own draft even with no new words.
  force?: boolean;
  whenLocked?: "copy";
};

const NOTHING_HELD = {
  attachmentIds: [],
  carriedFrom: [],
  quote: false,
  threaded: false,
};

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
          <span className="flex flex-none">
            <Spinner size={14} />
          </span>
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
    close: closeSession,
    reopen,
    moveSession,
  } = useCompose();
  const queryClient = useQueryClient();
  const toast = useToast();
  const content = loaded.draft?.content;
  const prefill = loaded.draft?.prefill ?? NOTHING_PREFILLED;

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
  const [working, setWorking] = useState<EditorWork | null>(null);
  const [locked, setLocked] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState<{
    failure: string | null;
  } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("unsaved");

  const body = useRef<HTMLDivElement>(null);
  // The last save runs as the form unmounts, when the editor element has already gone.
  const lastHtml = useRef(content?.html ?? "");
  const fileInput = useRef<HTMLInputElement>(null);
  // The draft on screen. Words can move to a new draft beside it while this form stays.
  const draftId = useRef(session.id);
  const [editorSession] = useState(() => crypto.randomUUID() as string);
  // Zero means there is no row yet: a reply is still only what it opened with.
  const revision = useRef(loaded.draft?.revision ?? 0);
  // What this screen and the server last agreed on, which a save compares itself to. Null
  // means it can't tell, so the words count as new.
  const agreed = useRef<string | null>(null);
  const movedFound = useRef(0);
  const lastChange = useRef<DraftChange | null>(null);
  const failedSaveCount = useRef(0);
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
  // What to tell someone who cleared a saved draft and left, when it couldn't go.
  const stillInDrafts = useRef<string | null>(null);
  // Forwarded files taken off before the row exists, which a first save already on its
  // way may still have copied.
  const takenOff = useRef(new Set<number>());
  const uploadingNow = useRef(0);
  const uploads = useRef(new Set<Promise<unknown>>());
  const discarding = useRef(false);
  const sendingNow = useRef(false);
  const saving = useRef<Promise<void>>(Promise.resolve());
  // A closing page cancels ordinary requests, so words on their way still count as unsaved.
  const savesUnderWay = useRef(0);
  const saveFailed = useRef(false);
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
  const addsSomething = (written: DraftContent) =>
    uploadingNow.current > 0 ||
    holdsSomethingAdded(
      {
        content: written,
        uploads: attachmentsNow.current.filter(
          ({ carriedFrom }) => carriedFrom === null,
        ).length,
      },
      prefill,
    );
  const startNow = (written: DraftContent) =>
    loaded.draft
      ? startOf({
          ...loaded.draft,
          revision: revision.current,
          content: written,
          attachments: attachmentsNow.current,
        })
      : undefined;
  const refreshList = () =>
    void queryClient.invalidateQueries({
      queryKey: composeKeys.outgoing(mailboxId),
    });
  const refreshKept = () =>
    void queryClient.invalidateQueries({
      queryKey: keptDraftsQuery(userId).queryKey,
    });
  const composeMode = () =>
    session.kind === "start" ? session.mode : (loaded.draft?.mode ?? "new");
  const baseNow = () => ({
    baseRevision: revision.current,
    session: editorSession,
  });
  const writtenNow = (content: DraftContent) =>
    agreed.current !== wordsOf(content);
  const shownNow = () =>
    attachmentsNow.current.map(({ id, carriedFrom }) => ({ id, carriedFrom }));
  const adoptRevision = (next: number | null) => {
    if (next !== null) revision.current = Math.max(revision.current, next);
  };
  const keptCopy = (content: DraftContent, keptAt: number) => ({
    id: draftId.current,
    mailboxId,
    keptAt,
    session: editorSession,
    written: writtenNow(content),
    content,
    revision: revision.current,
    mode: parentHeld.current || !loaded.draft ? composeMode() : "new",
    prefill,
    parent: parentHeld.current,
    quote: quoteHeld.current,
    quoteHtml: quoteHeld.current ? loaded.quoteHtml : null,
    attachments: attachmentsNow.current,
  });
  const nextKeptAt = () => Math.max(Date.now(), keptVersion.current + 1);
  const keepHere = async (content: DraftContent) => {
    // A new version of the same words could outrun a move to Drafts already under way,
    // and come back as a second draft.
    const words = JSON.stringify(content);
    if (keptHere.current && words === keptWords.current) return;
    const keptAt = nextKeptAt();
    try {
      keptHere.current = await keepDraft(userId, keptCopy(content, keptAt));
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
    await forgetKeptDraft(userId, draftId.current, keptVersion.current).catch(
      () => {},
    );
    keptVersion.current = 0;
    refreshKept();
  };
  // The server's draft no longer has everything this screen shows, or the words moved to
  // a draft of their own. If the screen has gone, the note waits on this device so the
  // person still finds out.
  const noteLeftOut = async (
    had: OutgoingAttachment[],
    content: DraftContent,
    holds: Extract<SaveResult, { status: "saved" }>["holds"],
    changed: DraftChange | null = null,
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
    const anyLeftOut = isLeftOut(leftOut);
    if (anyLeftOut) leftOutFound.current += 1;
    if (!anyLeftOut && !changed) return;
    if (mounted.current) {
      const lead = changed ? changedText(changed) : undefined;
      if (lead && !anyLeftOut) setNotice(lead);
      if (!anyLeftOut) return;
      const gone = had.filter((file) => !isHeld(file, holds));
      setAttachments((current) =>
        current.filter(
          (file) =>
            !gone.some(
              (one) =>
                one.id === file.id && one.carriedFrom === file.carriedFrom,
            ),
        ),
      );
      if (leftOut.quote) setIncludeQuote(false);
      setLeftOutNotice(leftOutText(leftOut, lead));
      return;
    }
    await keepNote(userId, {
      id: draftId.current,
      mailboxId,
      subject: content.subject,
      leftOut,
      changed,
    }).catch(() => {});
    refreshKept();
  };

  // The files the row now holds replace the original's, which the screen showed until now.
  const adoptCarried = (carried: OutgoingAttachment[]) => {
    const keep = (file: OutgoingAttachment) =>
      !takenOff.current.has(file.carriedFrom ?? 0);
    setAttachments((current) => [
      ...carried.filter(keep),
      ...current.filter(({ carriedFrom }) => carriedFrom === null),
    ]);
    for (const file of carried.filter((one) => !keep(one))) {
      void callAction(() =>
        removeOutgoingAttachment({
          data: {
            mailboxId,
            id: draftId.current,
            attachmentId: file.id,
            ...baseNow(),
          },
        }),
      )
        .then((result) => {
          if (result.status === "removed") adoptRevision(result.revision);
        })
        .catch(() => setAttachments((current) => [...current, file]));
    }
  };

  // `leaving` asks for a draft that now holds nothing to go, not just to wait.
  const flush = useCallback(
    (leaving = false, aim: SaveAim = {}): Promise<void> => {
      clearTimeout(timer.current);
      const changed = dirty.current;
      dirty.current = false;
      const content = read.current();
      if (changed) savesUnderWay.current += 1;
      saving.current = saving.current
        .then(async () => {
          const adds = addsSomething(content);
          const onServer = revision.current > 0;
          if (!adds) {
            setSaveState("unsaved");
            await forgetHere();
          }
          if (adds ? !changed : !(leaving && onServer)) return;
          // No later save can land. Words wait here for the person to choose.
          if (lockedNow.current && aim.whenLocked !== "copy") {
            if (adds) {
              dirty.current = true;
              await keepHere(content);
            }
            return;
          }
          // Files uploaded while this is on its way aren't in what the server answers with.
          const had = attachmentsNow.current;
          if (adds) setSaveState("saving");
          try {
            const result = await callAction(() =>
              saveDraft({
                data: {
                  mailboxId,
                  id: draftId.current,
                  ...baseNow(),
                  written: aim.force === true || writtenNow(content),
                  fileComing: uploadingNow.current > 0,
                  showing: shownNow(),
                  whenLocked: aim.whenLocked ?? "report",
                  content,
                  start: startNow(content),
                  leaving: !adds,
                },
              }),
            );
            setSaveProblem(null);
            noAccess.current = false;
            switch (result.status) {
              case "locked":
                lockedNow.current = true;
                if (adds) {
                  dirty.current = true;
                  setLocked(true);
                  await keepHere(content);
                }
                return;
              case "removed":
                revision.current = 0;
                return;
              case "changed":
                stillInDrafts.current = CHANGED_ELSEWHERE;
                return;
              case "nothing":
                return;
              case "behind":
                if (result.changed && mounted.current) {
                  setNotice(behindText(result.changed));
                }
                return;
              case "copied": {
                await forgetHere();
                draftId.current = result.id;
                revision.current = result.revision;
                agreed.current = wordsOf(content);
                movedFound.current += 1;
                lastChange.current = result.changed;
                lockedNow.current = false;
                setLocked(false);
                setProblem(null);
                setSaveState("saved");
                moveSession(session.editor, result.id);
                setAttachments(result.files);
                await noteLeftOut(had, content, result.holds, result.changed);
                refreshList();
                // Earlier work from this screen already went out from that draft.
                if (result.state !== "draft") {
                  lockedNow.current = true;
                  dirty.current = true;
                  setLocked(true);
                  setSaveState("unsaved");
                  await keepHere(content);
                }
                return;
              }
            }
            await forgetHere();
            adoptRevision(result.revision);
            agreed.current = wordsOf(content);
            setSaveState("saved");
            if (!onServer) adoptCarried(result.carried);
            await noteLeftOut(had, content, result.holds);
          } catch (error) {
            const message = (error as Error).message;
            const noAccessNow =
              error instanceof MailFailure && error.status === 403;
            // Text with nothing in it isn't worth keeping or offering back.
            if (!adds) {
              stillInDrafts.current = noAccessNow
                ? message
                : isOffline()
                  ? OFFLINE_DRAFT_NOT_REMOVED
                  : "We couldn't remove this draft, so it's still in Drafts. You can discard it there.";
              return;
            }
            dirty.current = true;
            saveFailed.current = true;
            failedSaveCount.current += 1;
            lastSaveError.current = message;
            await keepHere(content);
            if (noAccessNow) {
              noAccess.current = true;
              setSaveProblem(
                `${message} What you wrote is kept on this device.`,
              );
            }
          }
        })
        .finally(() => {
          if (changed) savesUnderWay.current -= 1;
          setSaveState((state) => (state === "saving" ? "unsaved" : state));
        });
      return saving.current;
    },
    [mailboxId],
  );

  // What might not outlive this page goes on the device before this returns.
  const keepOnDeviceNow = (content: DraftContent) => {
    if (discarding.current || sendingNow.current) return;
    if (!dirty.current && savesUnderWay.current === 0) return;
    if (!addsSomething(content)) return;
    const words = JSON.stringify(content);
    if (keptHere.current && words === keptWords.current) return;
    const keptAt = nextKeptAt();
    if (keepDraftNow(userId, keptCopy(content, keptAt))) {
      keptHere.current = true;
      keptVersion.current = keptAt;
      keptWords.current = words;
    }
  };

  // No later turn is coming, and a save ahead of this one would hold it back forever, so
  // this neither waits nor reads an answer. Words go to the device and the server at once,
  // and both landing is safe: the device's copy finds the server already holds them.
  const keepAsPageCloses = (leaving: boolean) => {
    if (discarding.current || sendingNow.current) return;
    const content = read.current();
    const adds = addsSomething(content);
    const unsaved = dirty.current || savesUnderWay.current > 0;
    if (adds ? !unsaved : !(leaving && revision.current > 0)) return;
    keepOnDeviceNow(content);
    if (lockedNow.current || isOffline()) return;
    void saveDraft({
      data: {
        mailboxId,
        id: draftId.current,
        ...baseNow(),
        written: writtenNow(content),
        fileComing: false,
        showing: shownNow(),
        whenLocked: "report",
        content,
        start: startNow(content),
        leaving: !adds,
      },
      fetch: outlivingThePage,
    }).catch(() => {});
  };
  const closingNow = useRef(keepAsPageCloses);
  closingNow.current = keepAsPageCloses;
  const hidingNow = useRef(() => keepOnDeviceNow(read.current()));
  hidingNow.current = () => keepOnDeviceNow(read.current());

  const touched = useCallback(() => {
    if (body.current) lastHtml.current = body.current.innerHTML;
    void getReadyToKeepNow(userId).catch(() => {});
    dirty.current = true;
    setSaveState("unsaved");
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
      action: { label: "Open", run: () => void reopen(draftId.current) },
    };
  };

  useEffect(() => {
    mounted.current = true;
    // Words kept from an earlier screen say for themselves whether they hold anything new.
    if (session.kind !== "kept" || !session.kept.written) {
      agreed.current = wordsOf(read.current());
    }
    // The first keystroke may be the last thing to happen before the page closes.
    void getReadyToKeepNow(userId).catch(() => {});
    return () => {
      mounted.current = false;
    };
  }, []);

  // What is left behind is the row, or the file on its way that will make one.
  const leftInDrafts = () =>
    stillInDrafts.current ??
    (revision.current > 0 || uploadingNow.current > 0 ? SAVED_TO_DRAFTS : null);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== "hidden") return;
      // A phone can end a hidden page with no further event.
      hidingNow.current();
      void flush();
    };
    const onPageHide = (event: PageTransitionEvent) =>
      closingNow.current(!event.persisted);
    document.addEventListener("visibilitychange", onHide);
    addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      removeEventListener("pagehide", onPageHide);
      clearTimeout(timer.current);
      if (!leftUnasked.current) return;
      void flush(true).then(() => {
        refreshList();
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
          return;
        }
        const left = lockedNow.current ? null : leftInDrafts();
        if (left) {
          toast({
            message: left,
            action: { label: "Open", run: () => void reopen(draftId.current) },
          });
        }
      });
    };
  }, [flush]);

  const closeEditor = async () => {
    if (working) return;
    setWorking("close");
    try {
      await keepAndClose();
    } finally {
      setWorking(null);
    }
  };

  const keepAndClose = async () => {
    const lockedBefore = lockedNow.current;
    const leftOutBefore = leftOutFound.current;
    const movedBefore = movedFound.current;
    await flush(true);
    // Something the person needs to read has only just appeared.
    if (lockedNow.current && !lockedBefore && dirty.current) return;
    if (leftOutFound.current !== leftOutBefore) return;
    if (movedFound.current !== movedBefore) return;
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
    if (lockedNow.current) return;
    const left = leftInDrafts();
    if (left && (left !== SAVED_TO_DRAFTS || session.kind !== "open")) {
      toast({ message: left });
    }
  };

  const discard = async () => {
    if (working) return;
    setWorking("discard");
    setConfirmingDiscard({ failure: null });
    discarding.current = true;
    clearTimeout(timer.current);
    dirty.current = false;
    // A file can take minutes and the person has finished with this message, so only the
    // words on the toast wait for it.
    const outlasting = uploads.current.size > 0;
    if (outlasting) close();
    let change: DraftChange | null = null;
    try {
      await discardWhenSettled({
        uploads: uploads.current,
        saving: saving.current,
        hasRow: () => revision.current > 0,
        discard: async () => {
          const result = await callAction(() =>
            discardOutgoing({
              data: { mailboxId, id: draftId.current, ...baseNow() },
            }),
          );
          if (result.status === "behind") change = result.changed;
        },
      });
      await forgetHere();
      if (!outlasting) close();
      refreshList();
      toast({
        message: change ? discardBehindText(change) : "Draft discarded.",
      });
    } catch (error) {
      discarding.current = false;
      setWorking(null);
      if (outlasting) {
        refreshList();
        toast({ tone: "danger", message: DISCARD_UNFINISHED });
        return;
      }
      dirty.current = true;
      setConfirmingDiscard({ failure: (error as Error).message });
    }
  };

  const saveAsNewDraft = async () => {
    setWorking("copy");
    try {
      await saveCopy();
    } finally {
      setWorking(null);
    }
  };

  const saveCopy = async () => {
    const movedBefore = movedFound.current;
    const failedBefore = failedSaveCount.current;
    dirty.current = true;
    await flush(false, { force: true, whenLocked: "copy" });
    if (movedFound.current !== movedBefore) {
      toast({ message: "Saved as a new draft." });
      return;
    }
    if (failedSaveCount.current !== failedBefore) {
      setSaveProblem(
        `We couldn't save a new draft, so your words are still here and on this device. ${lastSaveError.current}`,
      );
      return;
    }
    await forgetHere();
    dirty.current = false;
    close();
    toast({ message: "There was nothing new to save." });
  };

  const send = async () => {
    if (working || uploading.length > 0) {
      if (uploading.length > 0)
        setProblem("Wait for your files to finish uploading.");
      return;
    }
    if (isOffline()) {
      setProblem(OFFLINE_SEND_REFUSED);
      return;
    }
    setProblem(null);
    setWorking("send");
    // Anything typed while a save runs isn't a reason to stop: Send reads the fields again.
    const stoppedBySaving = async (aim: SaveAim) => {
      const leftOutBefore = leftOutFound.current;
      saveFailed.current = false;
      dirty.current = true;
      await flush(false, aim);
      if (saveFailed.current) {
        setWorking(null);
        setProblem(
          `We couldn't send this, because the latest version wouldn't save. ${lastSaveError.current}`,
        );
        return true;
      }
      if (lockedNow.current || leftOutFound.current !== leftOutBefore) {
        setWorking(null);
        return true;
      }
      return false;
    };
    // What was on screen may have gone from the server's draft, and sending without it
    // would be silent. A message with only words has nothing to lose this way.
    const couldLoseSomething =
      attachments.length > 0 || parentHeld.current || quoteHeld.current;
    if (couldLoseSomething && (await stoppedBySaving({}))) return;
    const movedBefore = movedFound.current;
    try {
      for (let tries = 0; ; tries += 1) {
        clearTimeout(timer.current);
        dirty.current = false;
        sendingNow.current = true;
        await saving.current;
        const content = read.current();
        const { status } = await call(() =>
          sendDraft({
            data: {
              mailboxId,
              id: draftId.current,
              ...baseNow(),
              content,
              start: startNow(content),
            },
          }),
        );
        if (status === "scheduled") break;
        // The draft moved on, so the words on this screen go from this person's own draft.
        sendingNow.current = false;
        if (tries + 1 === SEND_TRIES) throw new Error(SEND_KEPT_MOVING);
        if (await stoppedBySaving({ force: true })) return;
      }
      await forgetHere();
      close();
      refreshList();
      if (movedFound.current !== movedBefore && lastChange.current) {
        toast({ message: sentBesideText(lastChange.current) });
      }
    } catch (error) {
      sendingNow.current = false;
      dirty.current = true;
      setWorking(null);
      setProblem((error as Error).message);
      void flush();
    }
  };

  // A file can't join a draft that has moved on, so it follows this person's words to their
  // own. It goes again if the words moved while it was on its way.
  const uploadBeside = async (file: File): Promise<UploadedFile> => {
    for (let tries = 0; tries < SEND_TRIES; tries += 1) {
      const target = draftId.current;
      try {
        const uploaded = await uploadAttachment(
          mailboxId,
          target,
          file,
          startNow(read.current()),
          baseNow(),
        );
        if (target === draftId.current) return uploaded;
      } catch (error) {
        if (!(error instanceof DraftMovedOn)) throw error;
        if (target === draftId.current) {
          dirty.current = true;
          await flush(false, { force: true });
        }
      }
    }
    throw new UploadRefused(FILE_WENT_WRONG);
  };

  const addFiles = async (files: File[]) => {
    if (files.length === 0 || discarding.current) return;
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
    uploadingNow.current += files.length;
    setUploading((names) => [...names, ...files.map((file) => file.name)]);
    const queue = [...files];
    const worker = async () => {
      for (
        let file = queue.shift();
        file && !discarding.current;
        file = queue.shift()
      ) {
        const { name } = file;
        try {
          const uploaded = await uploadBeside(file);
          if (revision.current === 0) {
            adoptCarried(uploaded.carried);
            adoptRevision(uploaded.revision);
            if (uploaded.originalGone && !discarding.current) {
              await noteLeftOut(
                attachmentsNow.current,
                read.current(),
                NOTHING_HELD,
              );
            }
          }
          adoptRevision(uploaded.revision);
          setAttachments((current) => [...current, uploaded.attachment]);
        } catch (error) {
          setProblem(
            error instanceof UploadRefused ? error.message : FILE_WENT_WRONG,
          );
        } finally {
          uploadingNow.current -= 1;
          setUploading((names) => {
            const index = names.indexOf(name);
            return names.filter((_, position) => position !== index);
          });
        }
      }
    };
    const running = Promise.all(
      Array.from({ length: PARALLEL_UPLOADS }, worker),
    );
    uploads.current.add(running);
    await running;
    uploads.current.delete(running);
  };

  const removeAttachment = async (attachment: OutgoingAttachment) => {
    setAttachments((current) => current.filter((one) => one !== attachment));
    if (revision.current === 0 && attachment.carriedFrom !== null) {
      takenOff.current.add(attachment.carriedFrom);
      return;
    }
    try {
      const result = await callAction(() =>
        removeOutgoingAttachment({
          data: {
            mailboxId,
            id: draftId.current,
            attachmentId: attachment.id,
            ...baseNow(),
          },
        }),
      );
      if (result.status === "removed") {
        adoptRevision(result.revision);
        return;
      }
      // Taking a file off someone's newer draft isn't this person's to do. Their own new
      // draft simply won't have it.
      const movedBefore = movedFound.current;
      dirty.current = true;
      await flush(false, { force: true });
      if (movedFound.current === movedBefore) {
        setAttachments((current) => [...current, attachment]);
      }
    } catch (error) {
      setAttachments((current) => [...current, attachment]);
      setProblem((error as Error).message);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    // The Discard dialog sits inside this form, so its keys arrive here too.
    if (confirmingDiscard) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void send();
    } else if (event.key === "Escape") {
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
          disabled={working !== null}
          aria-busy={working === "close" || undefined}
          className="flex size-8 flex-none cursor-pointer items-center justify-center rounded text-secondary outline-accent hover:bg-field focus-visible:outline-2 disabled:cursor-default disabled:not-aria-busy:opacity-60 aria-busy:cursor-progress"
        >
          {working === "close" ? (
            <Spinner />
          ) : isPanel ? (
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
          {saveState === "saving"
            ? "Saving…"
            : saveState === "saved"
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
              disabled={working !== null}
              aria-busy={working === "copy" || undefined}
              className="inline-flex cursor-pointer items-center gap-1 font-medium underline outline-accent focus-visible:outline-2 disabled:cursor-default aria-busy:cursor-progress"
            >
              Save as a new draft
              {working === "copy" && <Spinner size={14} />}
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
            htmlFor={`${session.editor}-from`}
            className="w-10 flex-none text-sm text-secondary"
          >
            From
          </label>
          {addresses.length > 1 ? (
            <select
              id={`${session.editor}-from`}
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
              id={`${session.editor}-from`}
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
            htmlFor={`${session.editor}-subject`}
            className="w-14 flex-none text-sm text-secondary"
          >
            Subject
          </label>
          <input
            id={`${session.editor}-subject`}
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
          pending={working === "send"}
          disabled={locked || working !== null}
          onClick={() => void send()}
        >
          Send
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
          onClick={() => {
            if (
              nothingToDiscard({
                hasRow: revision.current > 0,
                savesUnderWay: savesUnderWay.current,
                uploadsUnderWay: uploads.current.size,
                keptOnDevice: keptHere.current,
                addsSomething: addsSomething(read.current()),
              })
            ) {
              close();
            } else {
              setConfirmingDiscard({ failure: null });
            }
          }}
          disabled={working !== null}
          className="flex size-9 cursor-pointer items-center justify-center rounded text-secondary outline-accent hover:bg-field hover:text-danger focus-visible:outline-2 disabled:cursor-default disabled:opacity-60"
        >
          <IconTrash size={18} stroke={1.75} aria-hidden />
        </button>
      </footer>
      {confirmingDiscard && (
        <Modal
          title="Discard this draft?"
          onClose={() => setConfirmingDiscard(null)}
          busy={working === "discard"}
        >
          <p className="text-sm text-secondary">
            You can't get it back after this.
          </p>
          {confirmingDiscard.failure && (
            <Notice tone="danger">{confirmingDiscard.failure}</Notice>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="quiet"
              autoFocus
              disabled={working === "discard"}
              onClick={() => setConfirmingDiscard(null)}
            >
              Keep it
            </Button>
            <Button
              variant="danger"
              pending={working === "discard"}
              disabled={working !== null}
              onClick={() => void discard()}
            >
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
            prefillDraft({
              data: {
                mailboxId,
                mode: session.mode,
                parentMessageId: session.parentMessageId,
              },
            }),
          )
        : call(() => getDraft({ data: { mailboxId, id: session.id } })).then(
            (result) => ({
              ...result,
              notice:
                result.draft.isCopy && !session.warning ? OPENED_A_COPY : null,
            }),
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
    // The session's editor says everything that matters about it. Its id can change only
    // while the form is showing, which has already loaded.
  }, [mailboxId, session.editor, attempt]);

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
      key={session.editor}
      session={session}
      loaded={loaded}
      addresses={addresses}
    />
  );
}
