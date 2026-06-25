# UAI Agents Team

6 ajanlı (1 lider + 5 worker) otonom multi-agent orkestrasyon sistemi.

## Hızlı Başlangıç

```bash
# 1. Servisleri başlat
cd uai
docker compose up -d

# 2. Bağımlılıkları kur
pnpm install

# 3. DB migration
pnpm db:migrate

# 4. Runtime başlat
pnpm --filter @uai/runtime dev

# 5. Health check
curl http://localhost:3000/health
```

## Yapı

```
uai/
├── apps/runtime/     # Agent loop, orchestrator, tools
├── apps/web/         # Next.js dashboard (Faz 4+)
├── packages/shared/  # Tipler, Zod şemaları, event tipleri
├── db/               # Drizzle schema + migrations
├── docs/             # İlerleme raporları, ADR'ler
├── config/           # Away mode policy vb.
└── scripts/          # Test & utility scriptleri
```

## Stack

| Katman | Teknoloji |
|---|---|
| Backend | TypeScript + Node 25 |
| Frontend | Next.js 15 (App Router) |
| Database | PostgreSQL 16 + pgvector |
| Queue | Redis 7 (pub/sub) |
| LLM | Anthropic Claude (SDK direct) |
| ORM | Drizzle |

## Portlar

| Servis | Port |
|---|---|
| Runtime API | 3000 |
| Web Dashboard | 3001 |
| PostgreSQL | 5434 |
| Redis | 6380 |
