import type { Database } from "bun:sqlite";
import { mock, setSystemTime } from "bun:test";
import {
  checkDriveAccess,
  type DriveGrant,
  type DriveId,
  type UserId,
} from "@cloudysuite/access";
import type { SqlDriver } from "@cloudysuite/object-sql";
import { createSqlDriver } from "@cloudysuite/object-sql/test-driver";
import { FakeBucket } from "@cloudysuite/transfer/fake-bucket";
import { createTestDatabase } from "../../../src/db/test-database";

mock.module("cloudflare:workers", () => ({
  env: {},
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
const { Drive } = await import("./drive");
const { openDrive } = await import("./client");

export const ALICE = "user-alice" as UserId;
export const BOB = "user-bob" as UserId;
export const DRIVE_A = "8b3f4e30-ac2d-4f90-9e77-2c3d4e5f6071" as DriveId;

type Instance = {
  sqlite: Database;
  db: SqlDriver;
  object: InstanceType<typeof Drive>;
  alarm: number | null;
};

// The real Durable Object class on bun:sqlite, against a D1 built from the real
// migrations. This proves the logic and the SQL, not the Workers runtime.
export async function createStorageTest() {
  const { sqlite: directory, d1 } = createTestDatabase();
  const bucket = new FakeBucket();
  const instances = new Map<string, Instance>();
  const d1Failures = { usageWrites: false };

  const database = new Proxy(d1, {
    get(target, property) {
      if (property !== "prepare") return Reflect.get(target, property);
      return (query: string) => {
        if (d1Failures.usageWrites && /^update "drives"/i.test(query)) {
          throw new Error("D1 is unavailable");
        }
        return target.prepare(query);
      };
    },
  });

  const env = {
    DB: database,
    BUCKET: bucket,
    DRIVE: {
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
    return new Drive(ctx as unknown as DurableObjectState, env);
  }

  function instanceOf(name: string): Instance {
    const existing = instances.get(name);
    if (existing) return existing;
    const { db, sqlite } = createSqlDriver();
    const instance = { db, sqlite, alarm: null } as unknown as Instance;
    instance.object = construct(instance);
    instances.set(name, instance);
    return instance;
  }

  for (const [id, name] of [
    [ALICE, "Alice Stone"],
    [BOB, "Bob Lee"],
  ] as const) {
    directory.run("INSERT INTO user (id, name, email) VALUES (?, ?, ?)", [
      id,
      name,
      `${id}@example.com`,
    ]);
  }
  directory.run(
    "INSERT INTO drives (id, kind, name, colour) VALUES (?, 'team', 'Marketing', 2)",
    [DRIVE_A],
  );
  directory.run(
    "INSERT INTO drive_access (drive_id, user_id, role) VALUES (?, ?, 'manager')",
    [DRIVE_A, ALICE],
  );

  async function grantFor(userId: UserId, driveId: DriveId) {
    const access = await checkDriveAccess(database, userId, driveId);
    if (!access.allowed) throw new Error("expected access");
    return access.grant;
  }

  const open = (grant: DriveGrant) => openDrive(env, grant);

  return {
    env,
    bucket,
    directory,
    d1: database,
    d1Failures,
    grantFor,
    open,
    drive: open(await grantFor(ALICE, DRIVE_A)),
    instance: (driveId: DriveId = DRIVE_A) => instanceOf(driveId),
    // Moves the clock to the alarm's time, as the runtime would, and runs it.
    async fireAlarm(driveId: DriveId = DRIVE_A) {
      const instance = instanceOf(driveId);
      const at = instance.alarm;
      if (at !== null) setSystemTime(new Date(at));
      try {
        await instance.object.alarm();
      } finally {
        setSystemTime();
      }
    },
    driveRow: () =>
      directory
        .query(
          "SELECT used_bytes, file_count, changed_at FROM drives WHERE id = ?",
        )
        .get(DRIVE_A) as {
        used_bytes: number;
        file_count: number;
        changed_at: number;
      },
  };
}
