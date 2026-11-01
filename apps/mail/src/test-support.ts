import { Database } from "bun:sqlite";
import { mock } from "bun:test";
import type { MailboxId } from "@cloudysuite/access";
import type { SqlDriver, SqlValue } from "./sql";

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

export function createSqlDriver(): { db: SqlDriver; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const db: SqlDriver = {
    exec: <Row>(query: string, ...bindings: SqlValue[]) => {
      const rows = sqlite.prepare(query).all(...(bindings as never[])) as Row[];
      return { toArray: () => rows };
    },
    transaction: (body) => sqlite.transaction(body)(),
  } as SqlDriver;
  return { db, sqlite };
}

export class FakeBucket {
  objects = new Map<string, Uint8Array>();
  failPutsMatching: RegExp | null = null;
  failDeletes = false;

  async put(key: string, value: ArrayBuffer | Uint8Array) {
    if (this.failPutsMatching?.test(key)) throw new Error("R2 is unavailable");
    this.objects.set(
      key,
      value instanceof Uint8Array ? value.slice() : new Uint8Array(value),
    );
  }

  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      body: new Blob([bytes as BlobPart]).stream(),
      text: async () => new TextDecoder().decode(bytes),
    };
  }

  async list({ prefix }: { prefix: string }) {
    return {
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    };
  }

  async delete(keys: string[]) {
    if (this.failDeletes) throw new Error("R2 is unavailable");
    for (const key of keys) this.objects.delete(key);
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
  }
}

type Instance = {
  sqlite: Database;
  db: SqlDriver;
  object: InstanceType<typeof Mailbox>;
  alarm: number | null;
};

// The real Durable Object class on bun:sqlite. This proves the logic and the SQL.
// It does not prove the Workers runtime, so run that behaviour there as well.
export function createTestEnv(database?: D1Database) {
  const bucket = new FakeBucket();
  const instances = new Map<string, Instance>();
  const env = {
    DB: database,
    BUCKET: bucket,
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
    } as unknown as Instance;
    instance.object = construct(instance);
    instances.set(name, instance);
    return instance;
  }

  return {
    env,
    bucket,
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
