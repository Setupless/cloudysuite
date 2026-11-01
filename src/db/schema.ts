import { sql } from "drizzle-orm";
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ToggleableApp } from "../routing";

export const domains = sqliteTable(
  "domains",
  {
    name: text().primaryKey(),
    isPrimary: integer("is_primary", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    uniqueIndex("domains_one_primary")
      .on(table.isPrimary)
      .where(sql`${table.isPrimary} = 1`),
  ],
);

export const appSettings = sqliteTable("app_settings", {
  app: text().$type<ToggleableApp>().primaryKey(),
  enabled: integer({ mode: "boolean" }).notNull(),
});
