CREATE TABLE IF NOT EXISTS "webhooks" (
  "id" text PRIMARY KEY NOT NULL,
  "url" text NOT NULL,
  "events" jsonb NOT NULL DEFAULT '[]',
  "secret" text,
  "active" integer NOT NULL DEFAULT 1,
  "fail_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp DEFAULT now(),
  "last_triggered_at" timestamp
);
