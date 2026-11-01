import { createTestDatabase } from "../../../src/db/test-database";
import type { Database } from "bun:sqlite";
import { mock, setSystemTime } from "bun:test";
import type { MailboxId } from "@cloudysuite/access";
import type { SqlDriver } from "@cloudysuite/object-sql";
import { createSqlDriver } from "@cloudysuite/object-sql/test-driver";
import { FakeBucket } from "@cloudysuite/transfer/fake-bucket";

export { createSqlDriver, FakeBucket };

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
const { Mailbox } = await import("./mailbox");

export const MAILBOX_A = "6f1d2c1e-8a0b-4d7e-9c55-0a1b2c3d4e5f" as MailboxId;
export const MAILBOX_B = "7a2e3d2f-9b1c-4e8f-8d66-1b2c3d4e5f60" as MailboxId;

type SentEmail = EmailMessageBuilder & { messageId: string };

// Records what the Worker asked to send. A queued throw plays the next answer.
export class FakeEmail {
  sent: SentEmail[] = [];
  nextThrows: unknown[] = [];
  // Runs inside send(), after the job has recorded its intent.
  beforeAnswer: (() => Promise<void>) | null = null;
  nextMessageId: string | null = null;

  async send(builder: EmailMessageBuilder): Promise<{ messageId: string }> {
    await this.beforeAnswer?.();
    const thrown = this.nextThrows.shift();
    if (thrown) throw thrown;
    const messageId =
      this.nextMessageId ?? `<${crypto.randomUUID()}@sending.example>`;
    this.sent.push({ ...builder, messageId });
    return { messageId };
  }
}

type Instance = {
  sqlite: Database;
  db: SqlDriver;
  object: InstanceType<typeof Mailbox>;
  alarm: number | null;
  // Moves the clock to the alarm's time, as the runtime would, and runs it.
  fireAlarm: () => Promise<void>;
};

// The real Durable Object class on bun:sqlite. This proves the logic and the SQL.
// It does not prove the Workers runtime, so run that behaviour there as well.
let emptyDirectory: D1Database | undefined;

export function createTestEnv(database?: D1Database) {
  const bucket = new FakeBucket();
  const email = new FakeEmail();
  const instances = new Map<string, Instance>();
  const env = {
    DB: database ?? (emptyDirectory ??= createTestDatabase().d1),
    BUCKET: bucket,
    EMAIL: email,
    MAILBOX: {
      idFromName: (name: string) => name,
      get: (name: string) => instanceOf(name).object,
    },
  } as unknown as Env;

  function construct(instance: Omit<Instance, "object">) {
    const ctx = {
      storage: {
        sql: { exec: instance.db.exec },
        transactionSync: instance.db.transaction,
        setAlarm: async (at: number) => {
          instance.alarm = at;
        },
        deleteAlarm: async () => {
          instance.alarm = null;
        },
        getAlarm: async () => instance.alarm,
        sync: async () => {},
      },
    };
    return new Mailbox(ctx as unknown as DurableObjectState, env);
  }

  function instanceOf(name: string): Instance {
    const existing = instances.get(name);
    if (existing) return existing;
    const { db, sqlite } = createSqlDriver();
    const instance = {
      db,
      sqlite,
      alarm: null,
      fireAlarm: async () => {
        const at = instance.alarm;
        if (at !== null) setSystemTime(new Date(at));
        try {
          await instance.object.alarm();
        } finally {
          setSystemTime();
        }
      },
    } as unknown as Instance;
    instance.object = construct(instance);
    instances.set(name, instance);
    return instance;
  }

  return {
    env,
    bucket,
    email,
    instanceOf,
    restart(name: string) {
      const instance = instanceOf(name);
      instance.object = construct(instance);
    },
  };
}

export type EmlOptions = {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  date?: string;
  headers?: string[];
  body?: string;
};

export function eml(options: EmlOptions): ArrayBuffer {
  const lines = [
    ...(options.headers ?? []),
    `From: ${options.from ?? "Alice <alice@example.org>"}`,
    `To: ${options.to ?? "Bob <bob@example.com>"}`,
    ...(options.cc ? [`Cc: ${options.cc}`] : []),
    `Subject: ${options.subject ?? "Hello"}`,
    `Date: ${options.date ?? "Mon, 02 Nov 2026 10:00:00 +0000"}`,
    ...(options.messageId ? [`Message-ID: <${options.messageId}>`] : []),
    ...(options.inReplyTo ? [`In-Reply-To: <${options.inReplyTo}>`] : []),
    ...(options.references ? [`References: ${options.references}`] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    options.body ?? "Hello there.",
  ];
  return toArrayBuffer(lines.join("\r\n"));
}

export function toArrayBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}
