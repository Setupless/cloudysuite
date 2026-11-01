import { createContext, useContext } from "react";
import type { MailListing, MoveId } from "../model";
import type { Folder, MailboxId, ThreadId } from "../types";
import type { ThreadCommands } from "./commands";
import type { LabelCommands } from "./label-commands";

export type MailViewContextValue = {
  mailboxId: MailboxId;
  view: MailListing;
  commands: ThreadCommands;
  movesOf: (folders: readonly Folder[]) => readonly MoveId[];
  act: (threadId: ThreadId, move: MoveId) => void;
  closeThread: () => void;
  labelCommands: LabelCommands;
  openLabels: (threadId: ThreadId) => void;
};

export const MailViewContext = createContext<MailViewContextValue | null>(null);

export function useMailView(): MailViewContextValue {
  const value = useContext(MailViewContext);
  if (!value) throw new Error("useMailView needs a MailViewScreen above it.");
  return value;
}
