CREATE TABLE `drive_shares` (
	`user_id` text NOT NULL,
	`drive_id` text NOT NULL,
	`item_id` text NOT NULL,
	CONSTRAINT `drive_shares_pk` PRIMARY KEY(`user_id`, `drive_id`, `item_id`),
	CONSTRAINT `fk_drive_shares_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_drive_shares_drive_id_drives_id_fk` FOREIGN KEY (`drive_id`) REFERENCES `drives`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `drive_shares_drive_id_idx` ON `drive_shares` (`drive_id`);
--> statement-breakpoint
UPDATE `drive_access` SET `role` = 'editor' WHERE `role` = 'member';
