import type { UserId } from "@cloudysuite/access";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOffline } from "../../pwa/connectivity";
import { forgetKeptNote } from "../../pwa/device-store";
import { isOffline, OFFLINE_COMPOSE_REFUSED } from "../../pwa/saved-mail";
import { runWhileVisible } from "../../pwa/while-visible";
import type { MailboxId, MessageId, ThreadId } from "../../types";
import { mailboxesQuery } from "../../queries";
import { useToast } from "../../ui/toast";
import { isLeftOut, keptNoteText, withoutAccess } from "../kept";
import {
  keptDraftsQuery,
  keptNotesQuery,
  readKeptDrafts,
  saveKeptDrafts,
} from "./kept-drafts";
import { composeContextQuery, composeKeys } from "./queries";
import { SendNotices, SendTray } from "./send-tray";
import type { ComposeMode, KeptDraft, KeptNote, OutgoingId } from "../types";

const RETRY_KEPT_MS = 60_000;

// What the editor should show, and where. A reply sits on its conversation's screen.
// Anything else is a panel beside the list, which on a phone fills the screen.
export type ComposeSession =
  | { kind: "new"; id: OutgoingId; host: "panel" }
  | {
      kind: "start";
      id: OutgoingId;
      host: "inline";
      threadId: ThreadId;
      mode: Exclude<ComposeMode, "new">;
      parentMessageId: MessageId;
    }
  | {
      kind: "open";
      id: OutgoingId;
      host: "panel" | "inline";
      threadId: ThreadId | null;
      warning: string | null;
    }
  | { kind: "kept"; id: OutgoingId; host: "panel"; kept: KeptDraft };

export type ComposeControls = {
  mailboxId: MailboxId;
  userId: UserId;
  session: ComposeSession | null;
  // Refused rather than queued: a message written on a train must not go out by surprise.
  refuseIfOffline: () => boolean;
  startNew: () => void;
  startFrom: (
    mode: Exclude<ComposeMode, "new">,
    parentMessageId: MessageId,
    threadId: ThreadId,
  ) => void;
  openDraft: (
    id: OutgoingId,
    options?: { threadId?: ThreadId; warning?: string },
  ) => void;
  // For a notice, which can outlast the screen the editor was on.
  reopen: (id: OutgoingId, warning?: string) => Promise<void>;
  close: () => void;
};

const ComposeContext = createContext<ComposeControls | null>(null);

export function useCompose(): ComposeControls {
  const value = useContext(ComposeContext);
  if (!value) throw new Error("useCompose needs a ComposeProvider above it.");
  return value;
}

const newId = () => crypto.randomUUID() as OutgoingId;

function KeptBand({
  count,
  offline,
  onOpen,
}: {
  count: number;
  offline: boolean;
  onOpen: () => void;
}) {
  const what =
    count === 1
      ? "A message you were writing is"
      : `${count} messages you were writing are`;
  return (
    <p
      role="status"
      className="flex flex-none items-center gap-3 border-b border-line bg-sidebar px-4 py-2 text-sm text-secondary"
    >
      <span className="min-w-0 flex-1">
        {offline
          ? `${what} kept on this device, and will go to Drafts when you reconnect.`
          : `${what} kept on this device, because we couldn't save to Drafts yet. We'll keep trying.`}
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="flex-none cursor-pointer font-medium text-accent outline-accent focus-visible:outline-2"
      >
        Open
      </button>
    </p>
  );
}

function LeftOutBand({
  note,
  onOpen,
  onDismiss,
}: {
  note: KeptNote;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-none flex-wrap items-center gap-3 border-b border-line bg-sidebar px-4 py-2 text-sm text-danger"
    >
      <span className="min-w-0 flex-1 basis-64">
        {!note.changed &&
          (note.subject
            ? `"${note.subject}" is in Drafts. `
            : "A message you wrote is in Drafts. ")}
        {keptNoteText(note)}
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="flex-none cursor-pointer font-medium text-accent outline-accent focus-visible:outline-2"
      >
        Open
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="flex-none cursor-pointer font-medium text-secondary outline-accent focus-visible:outline-2"
      >
        Dismiss
      </button>
    </div>
  );
}

export function ComposeProvider({
  mailboxId,
  userId,
  children,
}: {
  mailboxId: MailboxId;
  userId: UserId;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<ComposeSession | null>(null);
  // Loaded ahead, so the form opens at once when someone starts writing.
  useQuery(composeContextQuery(mailboxId));

  const toast = useToast();
  const refuseIfOffline = useCallback(() => {
    if (!isOffline()) return false;
    toast({ tone: "danger", message: OFFLINE_COMPOSE_REFUSED });
    return true;
  }, [toast]);

  const kept = useQuery(keptDraftsQuery(userId)).data ?? [];
  const keptNow = useRef(kept);
  keptNow.current = kept;
  const notes = useQuery(keptNotesQuery(userId)).data ?? [];
  const offline = useOffline();
  // Offline, this is only the device's last copy of the list, so it decides nothing.
  const mailboxes = useQuery(mailboxesQuery()).data;
  const knownMailboxes = useRef(mailboxes);
  knownMailboxes.current = offline ? undefined : mailboxes;
  const sessionNow = useRef(session);
  sessionNow.current = session;
  const navigate = useNavigate();

  const startNew = useCallback(() => {
    if (!refuseIfOffline())
      setSession({ kind: "new", id: newId(), host: "panel" });
  }, [refuseIfOffline]);
  const startFrom = useCallback<ComposeControls["startFrom"]>(
    (mode, parentMessageId, threadId) => {
      if (refuseIfOffline()) return;
      setSession({
        kind: "start",
        id: newId(),
        host: "inline",
        threadId,
        mode,
        parentMessageId,
      });
    },
    [refuseIfOffline],
  );
  const openDraft = useCallback<ComposeControls["openDraft"]>(
    (id, options) => {
      const held = keptNow.current.find((draft) => draft.id === id);
      if (held) {
        setSession({ kind: "kept", id, host: "panel", kept: held });
        return;
      }
      if (refuseIfOffline()) return;
      setSession({
        kind: "open",
        id,
        host: options?.threadId ? "inline" : "panel",
        threadId: options?.threadId ?? null,
        warning: options?.warning ?? null,
      });
    },
    [refuseIfOffline],
  );
  const close = useCallback(() => {
    setSession(null);
    void queryClient.invalidateQueries({
      queryKey: composeKeys.outgoing(mailboxId),
    });
  }, [queryClient, mailboxId]);

  const reopen = useCallback<ComposeControls["reopen"]>(
    async (id, warning) => {
      await navigate({
        to: "/mail/$mailboxId/$view",
        params: { mailboxId, view: "drafts" },
      });
      const drafts = await readKeptDrafts(userId);
      keptNow.current = drafts;
      openDraft(id, warning ? { warning } : undefined);
    },
    [navigate, mailboxId, userId, openDraft],
  );

  const saving = useRef(false);
  const saveKept = useCallback(async () => {
    if (saving.current || isOffline()) return;
    saving.current = true;
    try {
      const moved = await saveKeptDrafts(
        userId,
        sessionNow.current?.id,
        (id) =>
          !knownMailboxes.current ||
          knownMailboxes.current.some((one) => one.id === id),
      );
      if (moved.length === 0) return;
      void queryClient.invalidateQueries({
        queryKey: keptDraftsQuery(userId).queryKey,
      });
      for (const { draft } of moved) {
        void queryClient.invalidateQueries({
          queryKey: composeKeys.outgoing(draft.mailboxId),
        });
      }
      const [first] = moved;
      const onlyHere =
        moved.length === 1 && first?.draft.mailboxId === mailboxId;
      const firstNote = first && {
        subject: first.draft.content.subject,
        leftOut: first.leftOut,
        changed: first.changed,
      };
      toast({
        message:
          moved.length === 1
            ? first!.changed
              ? keptNoteText(firstNote!)
              : isLeftOut(first!.leftOut)
                ? "What you were writing is now in Drafts, but part of it couldn't come along."
                : "What you were writing is now in Drafts."
            : `${moved.length} messages you were writing are now in Drafts.${
                moved.some(({ changed }) => changed)
                  ? " Someone changed at least one of them while you were offline, so those words are in a new draft beside it."
                  : ""
              }`,
        action:
          onlyHere && first
            ? {
                label: "Open",
                run: () =>
                  void reopen(
                    first.savedAs,
                    first.changed || isLeftOut(first.leftOut)
                      ? keptNoteText(firstNote!)
                      : undefined,
                  ),
              }
            : undefined,
      });
    } catch {
      // This browser's storage can't be read, so the next try may do better.
    } finally {
      saving.current = false;
    }
  }, [userId, queryClient, mailboxId, toast, reopen]);

  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    const work = runWhileVisible(() => void saveKept(), RETRY_KEPT_MS);
    retry.current = work.runSoon;
    return work.stop;
  }, [saveKept]);
  const keptIds = kept.map((draft) => draft.id).join();
  useEffect(() => {
    if (!offline && keptIds) retry.current();
  }, [offline, keptIds, session?.id]);
  const lostHere = withoutAccess(kept, knownMailboxes.current);
  const keptHere = kept.filter(
    (draft) =>
      draft.mailboxId === mailboxId &&
      draft.id !== session?.id &&
      !lostHere.includes(draft),
  );
  const noteHere = notes.find((note) => note.mailboxId === mailboxId);
  const forgetNote = (note: KeptNote) =>
    forgetKeptNote(userId, note.id)
      .catch(() => {})
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: keptNotesQuery(userId).queryKey,
        }),
      );

  const value = useMemo(
    () => ({
      mailboxId,
      userId,
      session,
      refuseIfOffline,
      startNew,
      startFrom,
      openDraft,
      reopen,
      close,
    }),
    [
      mailboxId,
      userId,
      session,
      refuseIfOffline,
      startNew,
      startFrom,
      openDraft,
      reopen,
      close,
    ],
  );
  return (
    <ComposeContext.Provider value={value}>
      <div className="flex h-[calc(100dvh-3.25rem)] flex-col">
        <SendNotices />
        {noteHere && (
          <LeftOutBand
            note={noteHere}
            onOpen={() => {
              if (refuseIfOffline()) return;
              void reopen(noteHere.id, keptNoteText(noteHere));
              void forgetNote(noteHere);
            }}
            onDismiss={() => void forgetNote(noteHere)}
          />
        )}
        {keptHere[0] && (
          <KeptBand
            count={keptHere.length}
            offline={offline}
            onOpen={() => void reopen(keptHere[0]!.id)}
          />
        )}
        {/* Positioned, so screen-reader-only controls further down can't stretch the document. */}
        <div className="relative min-h-0 flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
      <SendTray />
    </ComposeContext.Provider>
  );
}
