# UAI Agents Monorepo — CLAUDE.md

> Bu dosya `projects/uai/` altında çalışırken okunur. Vault geneli kurallar için
> kök `CLAUDE.md`'ye bak.
>
> 📦 **Buraya 2026-09-02'de taşındı** (BL-174 denetimi). Önceden kök `CLAUDE.md`
> içindeydi ve her oturumda bağlama giriyordu; ölçüm oturumların yalnız **%14,6**'sının
> UAI'ye dokunduğunu gösterdi → 451 kelime, oturumların %85'inde boşa taşınıyordu.
> Bilgi silinmedi, gerektiği yere taşındı.

TypeScript pnpm workspace. Node ≥ 20. Tüm komutlar `projects/uai/` dizininden çalıştırılır.

## İlk Kurulum

```bash
pnpm install
pnpm setup             # ⭐ interaktif sihirbaz: sağlayıcı seç → anahtar gir → .env yazılır → başlat
                       #   (cross-platform, `1463ce6`; elle kurulum: cp .env.example .env → pnpm start)
```

## Geliştirme Komutları

```bash
# Altyapı (PostgreSQL + Redis Docker)
pnpm infra          # postgres + redis başlat
pnpm infra:down     # durdur
pnpm infra:full     # tüm servisler (uygulama dahil)

# Tam başlatma (infra → migrate → dev)
pnpm start

# Geliştirme (watch mode)
pnpm dev            # tüm paketler paralel
pnpm --filter @uai/runtime dev   # sadece runtime

# Veritabanı (Drizzle ORM)
pnpm db:generate    # migration üret
pnpm db:migrate     # migration uygula
pnpm db:studio      # Drizzle Studio aç

# Test & Lint
pnpm test                                              # tüm paketlerde vitest
pnpm --filter @uai/runtime test                        # tek paket
pnpm --filter @uai/runtime test -- path/to/test.ts     # tek dosya
pnpm lint           # TypeScript tip kontrolü (tsc --noEmit her pakette)
pnpm test:llm       # LLM entegrasyon testi
pnpm test:mcp       # MCP entegrasyon testi

# CLI + MCP + build
pnpm cli            # @uai/runtime CLI
pnpm mcp:serve      # MCP sunucusu (bkz. docs/MCP.md, `93e57b6`)
pnpm build          # tüm paketleri derle
pnpm infra:logs     # docker servis logları
```

## Monorepo Mimarisi

```
projects/uai/
├── apps/
│   ├── runtime/    # Ana çalışma zamanı: ajan orkestrasyon, HTTP/WebSocket sunucu
│   │   └── src/
│   │       ├── agents/         # 6 ajan (arch·brain·core·front·ops·qa) + base.ts
│   │       ├── orchestrator/   # Ajan koordinasyon motoru
│   │       ├── mcp/            # MCP istemci + sunucu (5 faz, `93e57b6`)
│   │       ├── projects/       # Proje kapsamı yönetimi
│   │       ├── queue.ts        # TaskQueue (ULID sıralı)
│   │       ├── learning.ts     # LearningSystem
│   │       ├── bus/            # In-process event bus
│   │       ├── llm/            # LLM istemci katmanı
│   │       ├── memory/         # pgvector hafıza
│   │       ├── tools/          # Ajan araçları
│   │       ├── webhooks/       # Webhook yönetimi
│   │       ├── approval/       # İnsan onayı bekleme kuyruğu
│   │       ├── middleware/     # HTTP middleware (X-Api-Key auth, rate limit)
│   │       └── server.ts       # HTTP/WebSocket giriş noktası
│   └── web/        # Next.js 15 dashboard
├── packages/
│   └── shared/     # @uai/shared — Zod şemaları, ortak tipler, event tipleri
└── db/             # @uai/db — Drizzle ORM şeması + migration'lar (PostgreSQL + pgvector)
```

**Portlar:** Runtime API → 3000 · Web Dashboard → 3001 · PostgreSQL → 5434 · Redis → 6380

**Kritik mimari detaylar:**
- Ajan iletişimi in-process event bus (`bus/`) üzerinden — RabbitMQ yok
- Hafıza katmanı: Redis (geçici) + pgvector (kalıcı embedding)
- LLM istemcisi `llm/` modülünde soyutlanmış — model değişimi bu katmanda yapılır
- `X-Api-Key` auth middleware tüm `/api/*` rotalarında zorunlu
- Rate limiting `middleware/` içinde, double-count bug'u fix edildi (2026-05-06)

## Açık işler

Güncel durum ve bekleyenler → `WIKI/hot.md` § UAI Agents Team ·
proje sayfası → `WIKI/sources/projects/` altında UAI kaydı.
