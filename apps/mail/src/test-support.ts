import { Database } from "bun:sqlite";
import { mock, setSystemTime } from "bun:test";
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
  failGets = false;
  uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  // Runs inside delete(), after the caller listed its keys and before they go.
  beforeDelete: (() => Promise<void>) | null = null;

  async put(key: string, value: ArrayBuffer | Uint8Array) {
    if (this.failPutsMatching?.test(key)) throw new Error("R2 is unavailable");
    this.objects.set(
      key,
      value instanceof Uint8Array ? value.slice() : new Uint8Array(value),
    );
  }

  async get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ) {
    if (this.failGets) throw new Error("R2 is unavailable");
    const whole = this.objects.get(key);
    if (!whole) return null;
    const { offset = 0, length = whole.length } = options?.range ?? {};
    const bytes = whole.subarray(offset, offset + length);
    return {
      body: new Blob([bytes as BlobPart]).stream(),
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }

  async head(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { size: bytes.length } : null;
  }

  // Applies R2's rules, so a test fails on what R2 itself would refuse.
  async createMultipartUpload(key: string) {
    const uploadId = crypto.randomUUID();
    this.uploads.set(uploadId, { key, parts: new Map() });
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const live = () => {
      const upload = this.uploads.get(uploadId);
      if (!upload) {
        throw new Error(
          "The specified multipart upload does not exist. (10024)",
        );
      }
      return upload;
    };
    return {
      key,
      uploadId,
      uploadPart: async (partNumber: number, value: ArrayBuffer) => {
        live().parts.set(partNumber, new Uint8Array(value));
        return { partNumber, etag: `etag-${partNumber}` };
      },
      abort: async () => {
        live();
        this.uploads.delete(uploadId);
      },
      complete: async (parts: { partNumber: number }[]) => {
        const upload = live();
        const sized = parts.map((part) => upload.parts.get(part.partNumber)!);
        const [first] = sized;
        if (sized.slice(0, -1).some((part) => part.length !== first!.length)) {
          throw new Error("All parts but the last must be the same size.");
        }
        const joined = new Uint8Array(
          sized.reduce((sum, part) => sum + part.length, 0),
        );
        let written = 0;
        for (const part of sized) {
          joined.set(part, written);
          written += part.length;
        }
        this.objects.set(key, joined);
        this.uploads.delete(uploadId);
        return { size: joined.length };
      },
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
    await this.beforeDelete?.();
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
  // Moves the clock to the alarm's time, as the runtime would, and runs it.
  fireAlarm: () => Promise<void>;
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
