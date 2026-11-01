import {
  applyRules,
  descriptionsToAsk,
  factsOf,
  NO_OUTCOME,
  type RuleOutcome,
} from "./rules/evaluate";
import { RuleStore } from "./rules/store";
import { RULE_MOVED, SpamStore } from "./spam/store";
import { opinionCouldDecide, type SpamVerdict } from "./spam/types";
import type { SqlDriver } from "@cloudysuite/object-sql";
import type { Folder, LabelId, NewMessage } from "./types";

export type Placement = {
  folder: Folder;
  read: boolean;
  starred: boolean;
  labelIds: LabelId[];
  // Set only when this puts the message in Spam, and it says why.
  spam: SpamVerdict | null;
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

// Nor must a problem with the filter: real mail matters more than catching spam.
function spamVerdict(message: NewMessage, db: SqlDriver): SpamVerdict | null {
  try {
    return new SpamStore(db).judge(message);
  } catch (error) {
    console.error(
      "Spam scoring could not run. The message is not filed.",
      error,
    );
    return null;
  }
}

// Rules run first and the spam verdict has the last word on the folder. A rule reads a
// From line that anyone can forge, so a rule must not be a way to talk past the spam
// filter. Each mailbox's allow list is the deliberate way to do that. Labels and stars
// still apply, so "Not spam" brings back the mail as it should have been. This runs
// inside the commit transaction, so a retry cannot apply it twice. A verdict can only
// choose where a message goes: spam is never rejected.
export function triageInbound(message: NewMessage, db: SqlDriver): Placement {
  const { move, read, starred, labelIds } = ruleOutcome(message, db);
  const verdict = spamVerdict(message, db);
  if (verdict?.spam) {
    return { folder: "spam", read, starred, labelIds, spam: verdict };
  }
  const folder = move ?? "inbox";
  const spam = folder === "spam" ? RULE_MOVED : null;
  return { folder, read, starred, labelIds, spam };
}

export type JevPlan = { askSpam: boolean; descriptions: string[] };

export const NOTHING_TO_ASK: JevPlan = { askSpam: false, descriptions: [] };

// What the optional check could still change for this message. Mail the filter already
// files is not sent to a third party, even to label it, and a label it misses is added
// by no one: "Not spam" brings such a message back without that rule's label.
export function jevPlanFor(message: NewMessage, db: SqlDriver): JevPlan {
  const verdict = new SpamStore(db).judge(message);
  if (verdict.spam) return NOTHING_TO_ASK;
  return {
    askSpam: opinionCouldDecide(verdict),
    descriptions: descriptionsToAsk(
      new RuleStore(db).enabled(),
      factsOf(message),
    ),
  };
}

// Imported and sent mail never reaches triage, so rules and spam skip it.
export function placementFor(message: NewMessage, db: SqlDriver): Placement {
  switch (message.source) {
    case "inbound":
      return triageInbound(message, db);
    case "import":
      return {
        folder: "archive",
        read: true,
        starred: false,
        labelIds: [],
        spam: null,
      };
    case "sent":
      return {
        folder: "sent",
        read: true,
        starred: false,
        labelIds: [],
        spam: null,
      };
  }
}
