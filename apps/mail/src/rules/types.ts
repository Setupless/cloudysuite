import type { Folder, LabelId } from "../types";

export const MAX_RULES = 100;
export const MAX_CONDITIONS = 5;
export const MAX_CONDITION_LENGTH = 200;
export const MAX_RULE_NAME_LENGTH = 100;
// Across a mailbox's rules, so one message can cost at most this many questions. The
// same words in two rules count once, because they are asked once.
export const MAX_DESCRIPTIONS = 5;

export type RuleId = number & { readonly __brand: "RuleId" };

export const RULE_TEXT_FIELDS = [
  "from",
  "to",
  "cc",
  "subject",
  "body",
] as const;
export type RuleTextField = (typeof RULE_TEXT_FIELDS)[number];

// Add a later signal as a new variant here. CONDITION_TESTS in evaluate.ts then won't
// compile until it says how to test it.
export type RuleCondition =
  | { kind: "contains"; field: RuleTextField; text: string }
  | { kind: "hasAttachment" }
  | { kind: "sentToAlias"; address: string }
  // Words a manager wrote, such as "an invoice", that the optional Jev check judges.
  | { kind: "looksLike"; text: string };

export const descriptionsIn = (
  conditions: readonly RuleCondition[],
): string[] =>
  conditions.flatMap((one) => (one.kind === "looksLike" ? [one.text] : []));

// Without a key, a rule with a description is paused as a whole. It must not keep
// running on its other conditions, because they were written to work together.
export const needsJev = ({ conditions }: { conditions: RuleCondition[] }) =>
  descriptionsIn(conditions).length > 0;

export type RuleMatch = "all" | "any";

export const RULE_FOLDERS = ["archive", "spam", "trash"] as const;
export type RuleFolder = (typeof RULE_FOLDERS)[number] & Folder;

// One move and one label per rule, so a rule can't contradict itself. Two labels
// are two rules, because every rule that matches applies. There is deliberately no
// forwarding, which would make the mailbox an open relay, and no permanent delete,
// so that a bad rule can't lose mail.
export type RuleActions = {
  move: RuleFolder | null;
  labelId: LabelId | null;
  markRead: boolean;
  star: boolean;
};

export type RuleDraft = {
  name: string;
  enabled: boolean;
  match: RuleMatch;
  conditions: RuleCondition[];
  actions: RuleActions;
};

export type Rule = RuleDraft & { id: RuleId };

export type RuleWrite =
  { ok: true; rule: Rule } | { ok: false; status: 404 | 409; message: string };

export const hasAction = ({ move, labelId, markRead, star }: RuleActions) =>
  move !== null || labelId !== null || markRead || star;

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === "object" && raw !== null;

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
const cleanText = (raw: string) => raw.replace(CONTROL, " ").trim();

function parseCondition(raw: unknown): RuleCondition | string {
  if (!isRecord(raw)) return "We couldn't read one of the conditions.";
  switch (raw.kind) {
    case "hasAttachment":
      return { kind: "hasAttachment" };
    case "sentToAlias": {
      const address =
        typeof raw.address === "string" ? raw.address.trim().toLowerCase() : "";
      return address.includes("@") && address.length <= MAX_CONDITION_LENGTH
        ? { kind: "sentToAlias", address }
        : "Choose the address the mail was sent to.";
    }
    case "contains": {
      const field = raw.field as RuleTextField;
      if (!RULE_TEXT_FIELDS.includes(field)) {
        return "We couldn't read one of the conditions.";
      }
      const text = typeof raw.text === "string" ? cleanText(raw.text) : "";
      if (text === "") return "Add the words each condition should look for.";
      if (text.length > MAX_CONDITION_LENGTH) {
        return `Keep each condition under ${MAX_CONDITION_LENGTH} characters.`;
      }
      return { kind: "contains", field, text };
    }
    case "looksLike": {
      const text = typeof raw.text === "string" ? cleanText(raw.text) : "";
      if (text === "") return "Describe what the message should look like.";
      if (text.length > MAX_CONDITION_LENGTH) {
        return `Keep each condition under ${MAX_CONDITION_LENGTH} characters.`;
      }
      return { kind: "looksLike", text };
    }
    default:
      return "We couldn't read one of the conditions.";
  }
}

function parseActions(raw: unknown): RuleActions | string {
  if (!isRecord(raw)) return "We couldn't read this rule's actions.";
  const { move, labelId, markRead, star } = raw;
  const validMove = move === null || RULE_FOLDERS.includes(move as RuleFolder);
  const validLabel =
    labelId === null ||
    (typeof labelId === "number" &&
      Number.isSafeInteger(labelId) &&
      labelId > 0);
  if (
    !validMove ||
    !validLabel ||
    typeof markRead !== "boolean" ||
    typeof star !== "boolean"
  ) {
    return "We couldn't read this rule's actions.";
  }
  return {
    move: move as RuleFolder | null,
    labelId: labelId as LabelId | null,
    markRead,
    star,
  };
}

// Every rule passes through this, from a browser and from storage. A string is what
// to tell the person. An enabled rule must have something to do, and a rule with no
// conditions must not exist, because it would match all mail.
export function parseRuleDraft(raw: unknown): RuleDraft | string {
  if (!isRecord(raw)) return "We couldn't read this rule.";
  const name = typeof raw.name === "string" ? cleanText(raw.name) : "";
  if (name === "") return "Give the rule a name.";
  if (name.length > MAX_RULE_NAME_LENGTH) {
    return `Keep the name under ${MAX_RULE_NAME_LENGTH} characters.`;
  }
  if (typeof raw.enabled !== "boolean") return "We couldn't read this rule.";
  if (raw.match !== "all" && raw.match !== "any") {
    return "We couldn't read this rule.";
  }
  if (!Array.isArray(raw.conditions) || raw.conditions.length === 0) {
    return "Add at least one condition.";
  }
  if (raw.conditions.length > MAX_CONDITIONS) {
    return `A rule can have up to ${MAX_CONDITIONS} conditions.`;
  }
  const conditions: RuleCondition[] = [];
  for (const candidate of raw.conditions) {
    const condition = parseCondition(candidate);
    if (typeof condition === "string") return condition;
    conditions.push(condition);
  }
  const actions = parseActions(raw.actions);
  if (typeof actions === "string") return actions;
  if (raw.enabled && !hasAction(actions)) return "Add at least one action.";
  return { name, enabled: raw.enabled, match: raw.match, conditions, actions };
}
