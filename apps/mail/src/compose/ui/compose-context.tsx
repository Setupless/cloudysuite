import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { MailboxId, MessageId, ThreadId } from "../../types";
import { composeContextQuery, composeKeys } from "./queries";
import { SendNotices, SendTray } from "./send-tray";
import type { ComposeMode, OutgoingId } from "../types";

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
    };

export type ComposeControls = {
  mailboxId: MailboxId;
  session: ComposeSession | null;
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
  close: () => void;
};

const ComposeContext = createContext<ComposeControls | null>(null);

export function useCompose(): ComposeControls {
  const value = useContext(ComposeContext);
  if (!value) throw new Error("useCompose needs a ComposeProvider above it.");
  return value;
}

const newId = () => crypto.randomUUID() as OutgoingId;

export function ComposeProvider({
  mailboxId,
  children,
}: {
  mailboxId: MailboxId;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<ComposeSession | null>(null);
  // Loaded ahead, so the form opens at once when someone starts writing.
  useQuery(composeContextQuery(mailboxId));

  const startNew = useCallback(
    () => setSession({ kind: "new", id: newId(), host: "panel" }),
    [],
  );
  const startFrom = useCallback<ComposeControls["startFrom"]>(
    (mode, parentMessageId, threadId) =>
      setSession({
        kind: "start",
        id: newId(),
        host: "inline",
        threadId,
        mode,
        parentMessageId,
      }),
    [],
  );
  const openDraft = useCallback<ComposeControls["openDraft"]>(
    (id, options) =>
      setSession({
        kind: "open",
        id,
        host: options?.threadId ? "inline" : "panel",
        threadId: options?.threadId ?? null,
        warning: options?.warning ?? null,
      }),
    [],
  );
  const close = useCallback(() => {
    setSession(null);
    void queryClient.invalidateQueries({
      queryKey: composeKeys.outgoing(mailboxId),
    });
  }, [queryClient, mailboxId]);

  const value = useMemo(
    () => ({ mailboxId, session, startNew, startFrom, openDraft, close }),
    [mailboxId, session, startNew, startFrom, openDraft, close],
  );
  return (
    <ComposeContext.Provider value={value}>
      <div className="flex h-[calc(100dvh-3.25rem)] flex-col">
        <SendNotices />
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
      <SendTray />
    </ComposeContext.Provider>
  );
}
