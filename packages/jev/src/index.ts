import { eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { jevUsage, orgSettings } from "../../../src/db/schema";

export const JEV_API = "https://api.typesafe.ai";

// An alias, not a pinned version: a copy of CloudySuite never updates itself, so a
// retired version would quietly end every check.
const MODEL = "jev-latest";

// Jev's docs say most calls take about 100 ms. This is the most a delivery can wait.
export const JEV_TIMEOUT_MS = 2000;
const KEY_CHECK_TIMEOUT_MS = 5000;

// A full answer is well under this. Anything larger isn't an answer.
export const MAX_RESPONSE_BYTES = 16 * 1024;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Local runs point this at a fake server through `.dev.vars`. A request cannot change
// env, and a Worker on Cloudflare cannot reach a loopback address, so this cannot send
// a key or message content anywhere else.
export function jevApiBase(override: string | undefined): string {
  const url = override ? URL.parse(override) : null;
  return url && LOOPBACK.has(url.hostname)
    ? url.href.replace(/\/$/, "")
    : JEV_API;
}

export type JevConnection = {
  base: string;
  key: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
};

export type YesNoQuestion = {
  instructions: string | Record<string, string>;
  criteria?: { true: string; false: string };
};

export type JevFailure =
  | "timeout"
  | "unreachable"
  | "rejected-key"
  | "rate-limited"
  | "overloaded"
  | "refused"
  | "bad-response";

export type JevAnswers =
  | { ok: true; yes: Record<string, number>; inputTokens: number }
  | { ok: false; failure: JevFailure };

const FAILURE_BY_STATUS: Record<number, JevFailure> = {
  401: "rejected-key",
  429: "rate-limited",
  529: "overloaded",
};

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw);

// Nothing from the response goes further than these numbers. An answer to a question
// not asked, a missing one, or a value out of range makes the whole response worthless.
export function parseAnswers(
  raw: unknown,
  asked: readonly string[],
): { yes: Record<string, number>; inputTokens: number } | null {
  if (!isRecord(raw) || !isRecord(raw.answers) || !isRecord(raw.usage)) {
    return null;
  }
  const { answers, usage } = raw;
  const inputTokens = usage.input_tokens;
  if (
    typeof raw.model !== "string" ||
    typeof inputTokens !== "number" ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    Object.keys(answers).length !== asked.length
  ) {
    return null;
  }
  const yes: Record<string, number> = {};
  for (const id of asked) {
    const answer = Object.hasOwn(answers, id) ? answers[id] : null;
    if (!isRecord(answer) || answer.type !== "noul") return null;
    const { noul } = answer;
    if (typeof noul !== "number" || !(noul >= 0 && noul <= 1)) return null;
    yes[id] = noul;
  }
  return { yes, inputTokens };
}

async function readLimited(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(whole);
}

// Never throws, and never retries: a delivery can't wait for a retry, and the built-in
// filter stands in for any failure. The clock covers reading the answer too, because
// a server can send its headers and then stall.
export async function askYesNo(
  connection: JevConnection,
  state: Record<string, string>,
  questions: Record<string, YesNoQuestion>,
): Promise<JevAnswers> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<JevAnswers>((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve({ ok: false, failure: "timeout" });
    }, JEV_TIMEOUT_MS);
  });
  const ask = async (): Promise<JevAnswers> => {
    try {
      const response = await connection.fetch(
        `${connection.base}/v1/systemone`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${connection.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: MODEL,
            state,
            questions: Object.fromEntries(
              Object.entries(questions).map(([id, question]) => [
                id,
                { type: "noul", ...question },
              ]),
            ),
          }),
          signal: abort.signal,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return {
          ok: false,
          failure: FAILURE_BY_STATUS[response.status] ?? "refused",
        };
      }
      const text = await readLimited(response);
      if (text === null) return { ok: false, failure: "bad-response" };
      const parsed = parseAnswers(JSON.parse(text), Object.keys(questions));
      return parsed
        ? { ok: true, ...parsed }
        : { ok: false, failure: "bad-response" };
    } catch (error) {
      return {
        ok: false,
        failure: error instanceof SyntaxError ? "bad-response" : "unreachable",
      };
    }
  };
  try {
    return await Promise.race([ask(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export type KeyCheck = "accepted" | "rejected" | "unknown";

// Listing models is the documented call that needs a key and spends no tokens.
export async function checkJevKey(
  connection: JevConnection,
): Promise<KeyCheck> {
  try {
    const response = await connection.fetch(`${connection.base}/v1/models`, {
      headers: { Authorization: `Bearer ${connection.key}` },
      signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.ok) return "accepted";
    return response.status === 401 ? "rejected" : "unknown";
  } catch {
    return "unknown";
  }
}

// The only read of the key. Anything that only needs to know one is set uses
// jevKeyIsSet, so the key can't reach a response by accident.
export async function readJevKey(database: D1Database): Promise<string | null> {
  const [row] = await drizzle(database)
    .select({ key: orgSettings.jevApiKey })
    .from(orgSettings);
  return row?.key ?? null;
}

export async function jevKeyIsSet(database: D1Database): Promise<boolean> {
  const rows = await drizzle(database)
    .select({ id: orgSettings.id })
    .from(orgSettings)
    .where(isNotNull(orgSettings.jevApiKey));
  return rows.length > 0;
}

export async function writeJevKey(
  database: D1Database,
  key: string | null,
): Promise<void> {
  await drizzle(database)
    .insert(orgSettings)
    .values({ id: 1, jevApiKey: key })
    .onConflictDoUpdate({
      target: orgSettings.id,
      set: { jevApiKey: key },
    });
}

export type JevUsage = { checks: number; failed: number; inputTokens: number };

const monthOf = (now: number) => new Date(now).toISOString().slice(0, 7);

export async function readJevUsage(
  database: D1Database,
  now: number,
): Promise<JevUsage> {
  const [row] = await drizzle(database)
    .select({
      checks: jevUsage.checks,
      failed: jevUsage.failed,
      inputTokens: jevUsage.inputTokens,
    })
    .from(jevUsage)
    .where(eq(jevUsage.month, monthOf(now)));
  return row ?? { checks: 0, failed: 0, inputTokens: 0 };
}

export async function recordJevUsage(
  database: D1Database,
  answers: JevAnswers,
  now: number,
): Promise<void> {
  const failed = answers.ok ? 0 : 1;
  const inputTokens = answers.ok ? answers.inputTokens : 0;
  await drizzle(database)
    .insert(jevUsage)
    .values({ month: monthOf(now), checks: 1, failed, inputTokens })
    .onConflictDoUpdate({
      target: jevUsage.month,
      set: {
        checks: sql`${jevUsage.checks} + 1`,
        failed: sql`${jevUsage.failed} + ${failed}`,
        inputTokens: sql`${jevUsage.inputTokens} + ${inputTokens}`,
      },
    });
}
