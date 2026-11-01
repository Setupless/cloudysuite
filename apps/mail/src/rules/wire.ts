import {
  badRequest,
  positiveId,
  record,
  refusal,
  requireMailboxId,
} from "../wire";
import {
  MAX_RULES,
  parseRuleDraft,
  type RuleDraft,
  type RuleId,
} from "./types";

const requireRuleId = (raw: unknown) => positiveId<RuleId>(raw);

function requireDraft(raw: unknown): RuleDraft {
  const draft = parseRuleDraft(raw);
  if (typeof draft === "string") throw refusal(400, draft);
  return draft;
}

export const parseNewRuleInput = (raw: unknown) => {
  const input = record(raw);
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    rule: requireDraft(input.rule),
  };
};

export const parseRuleChangeInput = (raw: unknown) => {
  const input = record(raw);
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    ruleId: requireRuleId(input.ruleId),
    rule: requireDraft(input.rule),
  };
};

export const parseRuleInput = (raw: unknown) => {
  const input = record(raw);
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    ruleId: requireRuleId(input.ruleId),
  };
};

export const parseReorderInput = (raw: unknown) => {
  const input = record(raw);
  if (!Array.isArray(input.ruleIds) || input.ruleIds.length > MAX_RULES) {
    throw badRequest();
  }
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    ruleIds: input.ruleIds.map(requireRuleId),
  };
};
