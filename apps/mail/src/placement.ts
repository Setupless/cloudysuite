import {
  applyRules,
  factsOf,
  NO_OUTCOME,
  type RuleOutcome,
} from "./rules/evaluate";
import { RuleStore } from "./rules/store";
import type { SqlDriver } from "./sql";
import type { Folder, LabelId, NewMessage } from "./types";

export type Placement = {
  folder: Folder;
  read: boolean;
  starred: boolean;
  labelIds: LabelId[];
};

// A problem with a rule must not stop mail: a throw here would fail the delivery.
function ruleOutcome(message: NewMessage, db: SqlDriver): RuleOutcome {
  try {
    const rules = new RuleStore(db).enabled();
    return rules.length > 0 ? applyRules(rules, factsOf(message)) : NO_OUTCOME;
  } catch (error) {
    console.error("Rules could not run. The message goes to the inbox.", error);
    return NO_OUTCOME;
  }
}

// Rules run first and spam scoring, when it plugs in here, has the last word on the
// folder. A rule reads a From line that anyone can forge, so a rule must not be a way
// to talk past the spam filter. Each mailbox's allow list is the deliberate way to do
// that. Labels and stars still apply, so "Not spam" brings back the mail as it should
// have been. This runs inside the commit transaction, so a retry cannot apply it
// twice. A verdict can only choose where a message goes: spam is never rejected.
export function triageInbound(message: NewMessage, db: SqlDriver): Placement {
  const { move, read, starred, labelIds } = ruleOutcome(message, db);
  return { folder: move ?? "inbox", read, starred, labelIds };
}

// Imported and sent mail never reaches triage, so rules and spam skip it.
export function placementFor(message: NewMessage, db: SqlDriver): Placement {
  switch (message.source) {
    case "inbound":
      return triageInbound(message, db);
    case "import":
      return { folder: "archive", read: true, starred: false, labelIds: [] };
    case "sent":
      return { folder: "sent", read: true, starred: false, labelIds: [] };
  }
}
