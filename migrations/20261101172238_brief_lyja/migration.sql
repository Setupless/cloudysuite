CREATE TABLE `drive_access` (
	`drive_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT `drive_access_pk` PRIMARY KEY(`drive_id`, `user_id`),
	CONSTRAINT `fk_drive_access_drive_id_drives_id_fk` FOREIGN KEY (`drive_id`) REFERENCES `drives`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_drive_access_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `drives` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`colour` integer NOT NULL,
	`owner_id` text,
	`used_bytes` integer DEFAULT 0 NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`changed_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT `fk_drives_owner_id_user_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON DELETE SET NULL,
	CONSTRAINT "drives_colour" CHECK("colour" BETWEEN 1 AND 6),
	CONSTRAINT "drives_owner_only_when_personal" CHECK("owner_id" IS NULL OR "kind" = 'personal')
);
--> statement-breakpoint
CREATE INDEX `drive_access_user_id_idx` ON `drive_access` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `drives_one_personal_per_owner` ON `drives` (`owner_id`) WHERE "drives"."kind" = 'personal';