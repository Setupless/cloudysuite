import { createContext, useContext } from "react";
import type { MoveId } from "../model";
import type { MailboxId, ThreadId, ThreadView } from "../types";
import type { ThreadCommands } from "./commands";

export type MailViewContextValue = {
  mailboxId: MailboxId;
  view: ThreadView;
  commands: ThreadCommands;
  moves: readonly MoveId[];
  act: (threadId: ThreadId, move: MoveId) => void;
  closeThread: () => void;
};

export const MailViewContext = createContext<MailViewContextValue | null>(null);

export function useMailView(): MailViewContextValue {
  const value = useContext(MailViewContext);
  if (!value) throw new Error("useMailView needs a MailViewScreen above it.");
  return value;
}
