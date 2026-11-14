CREATE TABLE `board_move_notices` (
	`user_id` text NOT NULL,
	`board_id` text NOT NULL,
	`move_id` text NOT NULL,
	CONSTRAINT `board_move_notices_pk` PRIMARY KEY(`user_id`, `board_id`, `move_id`),
	CONSTRAINT `fk_board_move_notices_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_board_move_notices_board_id_boards_id_fk` FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `board_move_notices_board_id_idx` ON `board_move_notices` (`board_id`);
