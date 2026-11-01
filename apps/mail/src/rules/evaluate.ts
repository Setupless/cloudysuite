import { recipientCandidates } from "../address";
import type { Address, LabelId, NewMessage } from "../types";
import type { Rule, RuleCondition, RuleFolder, RuleTextField } from "./types";

// What a rule can read about an arriving message, lowercased once. A later signal
// joins here and as a variant of RuleCondition.
export type RuleFacts = Record<RuleTextField, string> & {
  hasAttachment: boolean;
  deliveredTo: readonly string[];
};

const people = (list: Address[]) =>
  list
    .map((person) => `${person.name} ${person.address}`)
    .join(" ")
    .toLowerCase();

export function factsOf(message: NewMessage): RuleFacts {
  return {
    from: people(message.from ? [message.from] : []),
    to: people(message.to),
    cc: people(message.cc),
    subject: (message.subject ?? "").toLowerCase(),
    // Already cut to the first 1 MiB by ingest, so a hostile size can't get here.
    body: message.searchBody.toLowerCase(),
    hasAttachment: message.attachments.some((one) => !one.inline),
    deliveredTo: recipientCandidates(message.envelopeTo ?? ""),
  };
}

const CONDITION_TESTS: {
  [Kind in RuleCondition["kind"]]: (
    condition: Extract<RuleCondition, { kind: Kind }>,
    facts: RuleFacts,
  ) => boolean;
} = {
  contains: ({ field, text }, facts) =>
    facts[field].includes(text.toLowerCase()),
  hasAttachment: (_, facts) => facts.hasAttachment,
  sentToAlias: ({ address }, facts) => facts.deliveredTo.includes(address),
};

function holds(condition: RuleCondition, facts: RuleFacts): boolean {
  const test = CONDITION_TESTS[condition.kind] as (
    condition: RuleCondition,
    facts: RuleFacts,
  ) => boolean;
  return test(condition, facts);
}

export type RuleOutcome = {
  move: RuleFolder | null;
  labelIds: LabelId[];
  read: boolean;
  starred: boolean;
};

export const NO_OUTCOME: RuleOutcome = {
  move: null,
  labelIds: [],
  read: false,
  starred: false,
};

// Every rule that matches applies, top to bottom, and the highest one that moves the
// message decides where it goes.
export function applyRules(rules: Rule[], facts: RuleFacts): RuleOutcome {
  const outcome: RuleOutcome = { ...NO_OUTCOME, labelIds: [] };
  for (const { match, conditions, actions } of rules) {
    const matches =
      match === "all"
        ? conditions.every((condition) => holds(condition, facts))
        : conditions.some((condition) => holds(condition, facts));
    if (!matches) continue;
    outcome.move ??= actions.move;
    if (actions.labelId !== null) outcome.labelIds.push(actions.labelId);
    outcome.read ||= actions.markRead;
    outcome.starred ||= actions.star;
  }
  return outcome;
}
