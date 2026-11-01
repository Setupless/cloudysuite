CREATE TABLE `saved_mail_attachments` (
	`user_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`message_id` integer NOT NULL,
	`attachment_id` integer NOT NULL,
	`drive_id` text NOT NULL,
	`item_id` text,
	`saved_at` integer,
	`claimed_until` integer NOT NULL,
	CONSTRAINT `saved_mail_attachments_pk` PRIMARY KEY(`user_id`, `mailbox_id`, `message_id`, `attachment_id`),
	CONSTRAINT `fk_saved_mail_attachments_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_saved_mail_attachments_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_saved_mail_attachments_drive_id_drives_id_fk` FOREIGN KEY (`drive_id`) REFERENCES `drives`(`id`) ON DELETE CASCADE
);
