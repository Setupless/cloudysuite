CREATE TABLE `board_access` (
	`board_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT `board_access_pk` PRIMARY KEY(`board_id`, `user_id`),
	CONSTRAINT `fk_board_access_board_id_boards_id_fk` FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_board_access_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `boards` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`name` text,
	`colour` integer NOT NULL,
	`owner_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT `fk_boards_owner_id_user_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON DELETE SET NULL,
	CONSTRAINT "boards_colour" CHECK("colour" BETWEEN 1 AND 6),
	CONSTRAINT "boards_team_has_name" CHECK("kind" = 'personal' OR "name" IS NOT NULL),
	CONSTRAINT "boards_owner_only_when_personal" CHECK("owner_id" IS NULL OR "kind" = 'personal')
);
--> statement-breakpoint
CREATE INDEX `board_access_user_id_idx` ON `board_access` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `boards_one_personal_per_owner` ON `boards` (`owner_id`) WHERE "boards"."kind" = 'personal';