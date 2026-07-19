-- Postgres init script — /docker-entrypoint-initdb.d/ ile çalışır.
-- SADECE veri dizini (pgdata volume) BOŞ iken, container ilk kez ayağa
-- kalkarken bir kez koşar. Amaç: drizzle-kit migrate `vector(1536)` kolonunu
-- eklemeden ÖNCE pgvector extension'ının kurulu olmasını garanti etmek.
-- (Aksi halde extension yoksa migrate sessizce exit 1 ile başarısız oluyordu.)

CREATE EXTENSION IF NOT EXISTS vector;
