import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ToggleableApp } from "../routing";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type UserId = Brand<string, "UserId">;
export type MailboxId = Brand<string, "MailboxId">;

export const ORG_ROLES = ["admin", "user"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const MAILBOX_KINDS = ["personal", "shared"] as const;
export type MailboxKind = (typeof MAILBOX_KINDS)[number];

export const ADDRESS_KINDS = ["primary", "alias"] as const;
export type AddressKind = (typeof ADDRESS_KINDS)[number];

export const MAILBOX_ROLES = ["manager", "member"] as const;
export type MailboxRole = (typeof MAILBOX_ROLES)[number];

const now = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;
const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });
const flag = (name: string) => integer(name, { mode: "boolean" });

export const domains = sqliteTable(
  "domains",
  {
    name: text().primaryKey(),
    isPrimary: flag("is_primary").notNull().default(false),
  },
  (table) => [
    uniqueIndex("domains_one_primary")
      .on(table.isPrimary)
      .where(sql`${table.isPrimary} = 1`),
  ],
);

export const appSettings = sqliteTable("app_settings", {
  app: text().$type<ToggleableApp>().primaryKey(),
  enabled: flag("enabled").notNull(),
});

// Better Auth finds these by export name and field name, and refuses to run
// if they stop matching what it and its plugins expect.

export const user = sqliteTable("user", {
  id: text().$type<UserId>().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: flag("email_verified").notNull().default(false),
  image: text(),
  createdAt: timestamp("created_at").notNull().default(now),
  updatedAt: timestamp("updated_at")
    .notNull()
    .default(now)
    .$onUpdate(() => new Date()),
  role: text({ enum: ORG_ROLES }),
  banned: flag("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  twoFactorEnabled: flag("two_factor_enabled").default(false),
});

export const session = sqliteTable(
  "session",
  {
    id: text().primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text().notNull().unique(),
    createdAt: timestamp("created_at").notNull().default(now),
    updatedAt: timestamp("updated_at")
      .notNull()
      .$onUpdate(() => new Date()),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text().primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text(),
    password: text(),
    createdAt: timestamp("created_at").notNull().default(now),
    updatedAt: timestamp("updated_at")
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().default(now),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(now)
      .$onUpdate(() => new Date()),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const twoFactor = sqliteTable(
  "two_factor",
  {
    id: text().primaryKey(),
    secret: text().notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: flag("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: timestamp("locked_until"),
  },
  (table) => [
    index("two_factor_secret_idx").on(table.secret),
    index("two_factor_user_id_idx").on(table.userId),
  ],
);

export const passkey = sqliteTable(
  "passkey",
  {
    id: text().primaryKey(),
    name: text(),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer().notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: flag("backed_up").notNull(),
    transports: text(),
    createdAt: timestamp("created_at"),
    aaguid: text(),
  },
  (table) => [
    index("passkey_user_id_idx").on(table.userId),
    index("passkey_credential_id_idx").on(table.credentialID),
  ],
);

export const rateLimit = sqliteTable("rate_limit", {
  id: text().primaryKey(),
  key: text().notNull().unique(),
  count: integer().notNull(),
  lastRequest: integer("last_request").notNull(),
});

export const mailboxes = sqliteTable("mailboxes", {
  id: text()
    .$type<MailboxId>()
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID() as MailboxId),
  kind: text({ enum: MAILBOX_KINDS }).notNull(),
  name: text().notNull(),
  createdAt: timestamp("created_at").notNull().default(now),
});

export const addresses = sqliteTable(
  "addresses",
  {
    address: text().primaryKey(),
    domain: text()
      .notNull()
      .references(() => domains.name),
    mailboxId: text("mailbox_id")
      .$type<MailboxId>()
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    kind: text({ enum: ADDRESS_KINDS }).notNull(),
    createdAt: timestamp("created_at").notNull().default(now),
  },
  (table) => [
    index("addresses_mailbox_id_idx").on(table.mailboxId),
    uniqueIndex("addresses_one_primary_per_mailbox")
      .on(table.mailboxId)
      .where(sql`${table.kind} = 'primary'`),
    // Inbound mail resolves by exact match, so a mixed-case row would never receive anything.
    check(
      "addresses_lowercase",
      sql`${table.address} = lower(${table.address})`,
    ),
  ],
);

export const mailboxAccess = sqliteTable(
  "mailbox_access",
  {
    mailboxId: text("mailbox_id")
      .$type<MailboxId>()
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text({ enum: MAILBOX_ROLES }).notNull(),
    createdAt: timestamp("created_at").notNull().default(now),
  },
  (table) => [
    primaryKey({ columns: [table.mailboxId, table.userId] }),
    index("mailbox_access_user_id_idx").on(table.userId),
  ],
);

export const invites = sqliteTable(
  "invites",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tokenHash: text("token_hash").notNull().unique(),
    // Where the invite was sent. Reaching this inbox is the proof of ownership.
    email: text().notNull(),
    role: text({ enum: ORG_ROLES }).notNull(),
    // The new personal mailbox's address. Null when the person gets no mailbox.
    mailboxAddress: text("mailbox_address"),
    invitedBy: text("invited_by")
      .$type<UserId>()
      .references(() => user.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").notNull().default(now),
  },
  (table) => [index("invites_email_idx").on(table.email)],
);

export const orgSettings = sqliteTable(
  "org_settings",
  {
    id: integer().primaryKey().default(1),
    require2fa: flag("require_2fa").notNull().default(false),
    // Web push signing keys, generated once by the push feature.
    vapidPublicKey: text("vapid_public_key"),
    vapidPrivateKey: text("vapid_private_key"),
    jevApiKey: text("jev_api_key"),
  },
  (table) => [check("org_settings_one_row", sql`${table.id} = 1`)],
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text().notNull().unique(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull().default(now),
  },
  (table) => [index("push_subscriptions_user_id_idx").on(table.userId)],
);
