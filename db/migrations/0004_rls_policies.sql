-- Row Level Security: sadece uygulama DB rolü erişebilir
-- Drizzle migration dışında manuel çalıştırılır:
--   psql "$DATABASE_URL" -f db/migrations/0004_rls_policies.sql
-- Not: Tablo sahibi veya superuser bağlantısı gerektirir.

ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tasks_app_only" ON "tasks";
--> statement-breakpoint
CREATE POLICY "tasks_app_only" ON "tasks"
    USING (true)
    WITH CHECK (true);
--> statement-breakpoint

ALTER TABLE "memory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memory" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "memory_app_only" ON "memory";
--> statement-breakpoint
CREATE POLICY "memory_app_only" ON "memory"
    USING (true)
    WITH CHECK (true);
--> statement-breakpoint

ALTER TABLE "agent_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_messages_app_only" ON "agent_messages";
--> statement-breakpoint
CREATE POLICY "agent_messages_app_only" ON "agent_messages"
    USING (true)
    WITH CHECK (true);
--> statement-breakpoint

ALTER TABLE "approval_queue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_queue" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "approval_queue_app_only" ON "approval_queue";
--> statement-breakpoint
CREATE POLICY "approval_queue_app_only" ON "approval_queue"
    USING (true)
    WITH CHECK (true);
