-- memory_embedding_idx artık drizzle şemasında da tanımlı (db/schema.ts).
-- İndeks 0002_pgvector_memory_embedding.sql ile ZATEN kurulmuştu; bu migration
-- yalnızca drizzle'ın snapshot metadata'sını gerçeğe eşitler.
-- IF NOT EXISTS şart: mevcut bir veritabanında bu satır aksi hâlde
-- "relation already exists" ile patlar. (2026-08-11)
CREATE INDEX IF NOT EXISTS "memory_embedding_idx" ON "memory" USING hnsw ("embedding" vector_cosine_ops);
