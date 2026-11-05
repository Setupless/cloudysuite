CREATE TABLE `calendar_access` (
	`calendar_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT `calendar_access_pk` PRIMARY KEY(`calendar_id`, `user_id`),
	CONSTRAINT `fk_calendar_access_calendar_id_calendars_id_fk` FOREIGN KEY (`calendar_id`) REFERENCES `calendars`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_calendar_access_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `calendars` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`name` text,
	`colour` integer NOT NULL,
	`owner_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT `fk_calendars_owner_id_user_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON DELETE SET NULL,
	CONSTRAINT "calendars_colour" CHECK("colour" BETWEEN 1 AND 6),
	CONSTRAINT "calendars_team_has_name" CHECK("kind" = 'personal' OR "name" IS NOT NULL),
	CONSTRAINT "calendars_owner_only_when_personal" CHECK("owner_id" IS NULL OR "kind" = 'personal')
);
--> statement-breakpoint
CREATE INDEX `calendar_access_user_id_idx` ON `calendar_access` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendars_one_personal_per_owner` ON `calendars` (`owner_id`) WHERE "calendars"."kind" = 'personal';