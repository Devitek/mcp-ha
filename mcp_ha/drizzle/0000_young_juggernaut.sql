CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`grants` text NOT NULL,
	`entity_allowlist` text,
	`entity_denylist` text,
	`created_at` text NOT NULL,
	`expires_at` text,
	`last_used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_name_unique` ON `tokens` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_hash_unique` ON `tokens` (`hash`);--> statement-breakpoint
CREATE INDEX `idx_tokens_hash` ON `tokens` (`hash`);