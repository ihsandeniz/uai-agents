-- Row Level Security: sadece uygulama DB rolü erişebilir
--
-- ⚠️ BU BİR DRIZZLE MIGRATION'I DEĞİL. _journal.json'da kaydı YOK, dolayısıyla
-- `pnpm db:migrate` bunu UYGULAMAZ — sıfır bir veritabanında RLS kapalı gelir
-- (2026-08-08'de temiz bir postgres'te ölçüldü: pg_class.relrowsecurity hiçbir
-- tabloda true değil). Bilinçli tercih: tablo sahibi/superuser bağlantısı ister.
--
-- Elle çalıştır:
--   pnpm db:rls          (2026-08-11'de eklendi — eskiden yalnız bu yorumda yazıyordu)
--   psql "$DATABASE_URL" -f db/migrations/manual/rls_policies.sql
--
-- Eskiden adı `0004_rls_policies.sql` idi; numaralı sıraya benzediği için
-- migration sanılıyordu ve bir sonraki gerçek migration da 0004 olacaktı.

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
