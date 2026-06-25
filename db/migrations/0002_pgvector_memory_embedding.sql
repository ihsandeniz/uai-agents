CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
ALTER TABLE "memory" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_embedding_idx" ON "memory" USING hnsw ("embedding" vector_cosine_ops);
