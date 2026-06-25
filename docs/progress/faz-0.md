# Faz 0 — Foundation

**Tarih:** 2026-05-04  
**Durum:** Tamamlandı

## Ne Yapıldı

- [x] Monorepo kurulumu (pnpm workspaces): `apps/runtime`, `apps/web`, `packages/shared`, `db`
- [x] `docker-compose.yml`: Postgres 16 (pgvector) + Redis 7 ayağa kalkıyor (port 5434/6380)
- [x] Drizzle schema yazıldı (7 tablo: projects, tasks, memory, agent_messages, checkpoints, approval_queue, learning_log)
- [x] İlk migration başarıyla uygulandı
- [x] `packages/shared` kurulu: types.ts, schemas.ts (Zod), events.ts
- [x] Anthropic SDK wrapper (`apps/runtime/src/llm/client.ts`) — `complete()` ve `embed()` (Faz 2'de aktif)
- [x] Pino logger merkezi (`apps/runtime/src/logger.ts`)
- [x] Health check endpoint: `GET /health` → DB + Redis ping, 200 OK
- [x] SSE endpoint stub: `GET /api/stream`
- [x] Next.js placeholder dashboard (port 3001)
- [x] LLM test scripti (`scripts/test-llm.ts`)

## Ne Çalışıyor

- `docker compose up -d` → Postgres + Redis healthy
- `pnpm --filter @uai/runtime dev` → server :3000 ayağa kalkıyor
- `curl localhost:3000/health` → `{"status":"ok","db":true,"redis":true}`
- TypeScript tip kontrolü geçiyor (shared + runtime)
- Drizzle migration başarılı

## Ne Çalışmıyor / Eksik

- LLM test scripti henüz çalıştırılmadı (ANTHROPIC_API_KEY gerekiyor)
- pgvector extension henüz aktif değil (Faz 2'de eklenecek)
- Next.js dashboard sadece placeholder (Faz 4'te dolacak)

## Kararlar

- Port 5434 kullanıldı (5433 başka projede meşgul)
- Embedding Faz 2'ye ertelendi — Faz 1'de keyword-based memory
- Yol B (Mastra Hybrid) seçildi — Faz 0-1 framework'süz, Faz 2'de Mastra entegrasyonu
