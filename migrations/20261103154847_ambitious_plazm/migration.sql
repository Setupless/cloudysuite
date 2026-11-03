CREATE TABLE `drive_move_notices` (
	`user_id` text NOT NULL,
	`drive_id` text NOT NULL,
	`move_id` text NOT NULL,
	CONSTRAINT `drive_move_notices_pk` PRIMARY KEY(`user_id`, `drive_id`, `move_id`),
	CONSTRAINT `fk_drive_move_notices_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_drive_move_notices_drive_id_drives_id_fk` FOREIGN KEY (`drive_id`) REFERENCES `drives`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `drive_move_notices_drive_id_idx` ON `drive_move_notices` (`drive_id`);