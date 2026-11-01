-- Written by hand. drizzle-kit rebuilds the table to add a check, and on D1 its DROP TABLE cascades and empties drive_access, so everyone would lose their folders.
ALTER TABLE `drives` ADD `limit_bytes` integer CONSTRAINT "drives_limit_only_when_personal" CHECK("limit_bytes" IS NULL OR "kind" = 'personal');--> statement-breakpoint
ALTER TABLE `org_settings` ADD `storage_limit_bytes` integer;
