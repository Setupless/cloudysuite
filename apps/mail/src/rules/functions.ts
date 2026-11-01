import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { addresses } from "../../../../src/db/schema";
import { openMailboxFor, openRuleEditorFor } from "../access";
import { parseMailboxInput, refusal } from "../wire";
import type { RuleWrite } from "./types";
import {
  parseNewRuleInput,
  parseReorderInput,
  parseRuleChangeInput,
  parseRuleInput,
} from "./wire";

const savedRule = (write: RuleWrite) => {
  if (!write.ok) throw refusal(write.status, write.message);
  return write.rule;
};

export const getRules = createServerFn({ method: "GET" })
  .validator(parseMailboxInput)
  .handler(async ({ data }) => {
    const mailbox = await openMailboxFor(getRequest(), data.mailboxId);
    const rows = await drizzle(env.DB)
      .select({ address: addresses.address })
      .from(addresses)
      .where(eq(addresses.mailboxId, data.mailboxId))
      .orderBy(asc(addresses.address));
    return {
      rules: await mailbox.listRules(),
      addresses: rows.map((row) => row.address),
    };
  });

export const createRule = createServerFn({ method: "POST" })
  .validator(parseNewRuleInput)
  .handler(async ({ data }) => {
    const editor = await openRuleEditorFor(getRequest(), data.mailboxId);
    return savedRule(await editor.create(data.rule));
  });

export const updateRule = createServerFn({ method: "POST" })
  .validator(parseRuleChangeInput)
  .handler(async ({ data }) => {
    const editor = await openRuleEditorFor(getRequest(), data.mailboxId);
    return savedRule(await editor.update(data.ruleId, data.rule));
  });

export const deleteRule = createServerFn({ method: "POST" })
  .validator(parseRuleInput)
  .handler(async ({ data }) => {
    const editor = await openRuleEditorFor(getRequest(), data.mailboxId);
    await editor.remove(data.ruleId);
  });

export const reorderRules = createServerFn({ method: "POST" })
  .validator(parseReorderInput)
  .handler(async ({ data }) => {
    const editor = await openRuleEditorFor(getRequest(), data.mailboxId);
    if (!(await editor.reorder(data.ruleIds))) {
      throw refusal(
        409,
        "The rules changed while you were moving them. Look them over, then try again.",
      );
    }
  });
