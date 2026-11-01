CREATE TABLE `jev_usage` (
	`month` text PRIMARY KEY,
	`checks` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL
);
