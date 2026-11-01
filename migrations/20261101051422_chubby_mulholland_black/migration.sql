CREATE TABLE `app_settings` (
	`app` text PRIMARY KEY,
	`enabled` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `domains` (
	`name` text PRIMARY KEY,
	`is_primary` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_one_primary` ON `domains` (`is_primary`) WHERE "domains"."is_primary" = 1;