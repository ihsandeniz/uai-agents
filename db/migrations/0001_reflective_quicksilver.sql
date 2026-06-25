CREATE TABLE "routing_records" (
	"id" text PRIMARY KEY NOT NULL,
	"goal" text NOT NULL,
	"assigned_to" text NOT NULL,
	"confidence" real NOT NULL,
	"cost_usd" real NOT NULL,
	"duration_ms" integer NOT NULL,
	"success" integer NOT NULL,
	"created_at" timestamp DEFAULT now()
);
