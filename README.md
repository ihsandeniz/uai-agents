# UAI Agents Team

[English](./README.en.md) · **Türkçe**

> Kendi sunucunda çalışan, 6 ajanlı otonom multi-agent orkestrasyon sistemi.
> A self-hostable, 6-agent autonomous orchestration system. Bring your own LLM key.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Node%2020+-3178c6.svg)](https://www.typescriptlang.org/)
[![BYOK](https://img.shields.io/badge/LLM-BYOK%20(OpenRouter%2FOpenAI%2FGemini%2FOllama)-8b5cf6.svg)](#llm-sağlayıcı-byok)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)
[![GitHub stars](https://img.shields.io/github/stars/ihsandeniz/uai-agents?style=social)](https://github.com/ihsandeniz/uai-agents/stargazers)

Bir görev gönderirsin; **Core** ajan görevi analiz eder ve en uygun uzman ajana
yönlendirir; **QA** ajanı sonucu doğrular. Geçmiş işler pgvector'e gömülür,
yönlendirme kararları zamanla öğrenerek iyileşir. Tamamı TypeScript, dış kuyruk
sistemi yok (in-process event bus), LLM sağlayıcısı `.env`'den tek satırla değişir.

---

## Öne Çıkanlar

- 🧭 **Otomatik yönlendirme** — Core ajan görevi analiz edip doğru uzman ajanı kendi seçer
- 🧠 **Semantik hafıza** — geçmiş işlemler embedding'e döner, benzer görevler pgvector ile bulunur
- 📈 **Öğrenen yönlendirme** — ajan performansı kalıcı tutulur, kararlar zamanla iyileşir
- 🔀 **DAG tabanlı paralellik** — alt görevler bağımlılık grafiğiyle paralel yürür, deadlock koruması
- 🔗 **Webhook** — sonuçlar HTTP POST ile dışa gider; 5 hatadan sonra otomatik devre dışı
- ⏸️ **Away mode** — sistem insan onayını bekler; kuyruk saat/gün bazlı duraklatılabilir
- 🔑 **BYOK** — OpenRouter / OpenAI / Gemini / Ollama / özel endpoint arasında `.env` ile geçiş
- 🔌 **MCP** — dış MCP sunucularının araçlarını ajanlara kazandırır (stdio + HTTP) **ve** UAI'yi MCP sunucusu olarak dışa sunar → [`docs/MCP.md`](./docs/MCP.md)

---

## Hızlı Başlangıç

**Gereksinimler:** Node.js ≥ 20, [pnpm](https://pnpm.io/), Docker (+ Compose).
Hepsi **Windows 10/11, Linux ve macOS**'ta çalışır.

### Kolay yol — kurulum sihirbazı (önerilen)

```bash
git clone https://github.com/ihsandeniz/uai-agents.git
cd uai-agents
pnpm install
pnpm setup        # interaktif: sağlayıcı seç → anahtar gir → .env yazılır → başlat
```

Sihirbaz gereksinimleri kontrol eder, LLM sağlayıcını sorar, `UAI_API_KEY`'i
otomatik üretir, `.env`'i yazar ve istersen altyapıyı ayağa kaldırıp migration'ı
çalıştırır. Bağımlılıksız, saf Node — her platformda aynı.

### Elle kurulum (alternatif)

```bash
cp .env.example .env      # Windows: copy .env.example .env
# .env içinde LLM_PROVIDER + anahtarını doldur (aşağıya bak)
pnpm install

docker compose up -d --wait   # PostgreSQL (pgvector) + Redis, sağlıklı olana kadar bekler
pnpm db:migrate               # şema + pgvector eklentisi otomatik kurulur

pnpm --filter @uai/runtime dev
curl http://localhost:3000/health
```

Tek komutla (infra → migrate → dev):

```bash
pnpm start
```

---

## LLM Sağlayıcı (BYOK)

Sistem **kendi anahtarını getir** mantığıyla çalışır — hiçbir sağlayıcıya kilitli
değildir. `.env` içinde tek satır değiştirmen yeterli, kod değişmez:

```bash
LLM_PROVIDER=openrouter   # openrouter | openai | gemini | ollama | custom
OPENROUTER_API_KEY=sk-or-...
```

| Sağlayıcı | Gereken | Not |
|---|---|---|
| `openrouter` | `OPENROUTER_API_KEY` | Varsayılan — [openrouter.ai/keys](https://openrouter.ai/keys) |
| `openai` | `OPENAI_API_KEY` | |
| `gemini` | `GEMINI_API_KEY` | Google'ın OpenAI-uyumlu endpoint'i |
| `ollama` | — | Lokal, **ücretsiz & sınırsız** (`http://localhost:11434`) |
| `custom` | `LLM_API_KEY` + `LLM_BASE_URL` | LM Studio / Groq / Together / vLLM |

Tüm katman OpenAI-uyumlu tek istek arayüzüne indirgenmiştir (`apps/runtime/src/llm/`).

---

## MCP (Model Context Protocol)

UAI hem **MCP istemcisi** hem **MCP sunucusudur** — tamamen opsiyonel (env set
edilmezse davranış değişmez).

```bash
# İstemci: dış MCP araçlarını ajanlara kazandır (mcp__<sunucu>__<araç>)
MCP_ENABLED=true MCP_SERVER_COMMAND=npx \
  MCP_SERVER_ARGS="-y @modelcontextprotocol/server-filesystem /tmp" pnpm dev
# …veya çoklu sunucu için MCP_SERVERS='[{...}]' (stdio + http)

# Sunucu: UAI'nin araçlarını dışa sun (stdio veya HTTP + X-Api-Key)
pnpm mcp:serve
```

Köprüleme (JSON Schema → düz argüman), çoklu sunucu + dayanıklılık, ajan aboneliği
(`MCP_AGENTS`), observability ve `uai_run_bash` allowlist ayrıntıları →
[`docs/MCP.md`](./docs/MCP.md). Örnek yapılandırmalar → [`examples/mcp/`](./examples/mcp).
Uçtan uca canlı test: `pnpm test:mcp`.

## Yapı

```
uai-agents/
├── apps/
│   ├── runtime/     # Ajan döngüsü, orchestrator, araçlar, HTTP/WS sunucu
│   └── web/         # Next.js 15 dashboard
├── packages/shared/ # Zod şemaları, ortak tipler, event tipleri
├── db/              # Drizzle şema + migration'lar + pgvector init
├── config/          # Away mode policy vb.
├── docs/            # İlerleme raporları, ADR'ler, MCP.md
├── examples/        # Örnek yapılandırmalar (mcp/)
└── scripts/         # Test & yardımcı scriptler (uai-mcp-server.ts, test-mcp.ts)
```

## Stack

| Katman | Teknoloji |
|---|---|
| Backend | TypeScript + Node ≥ 20 |
| Frontend | Next.js 15 (App Router) |
| Database | PostgreSQL 16 + pgvector |
| Cache/Bus | Redis 7 + in-process event bus |
| LLM | BYOK (OpenAI-uyumlu — OpenRouter/OpenAI/Gemini/Ollama/custom) |
| ORM | Drizzle |

## Portlar

| Servis | Port |
|---|---|
| Runtime API | 3000 |
| Web Dashboard | 3001 |
| PostgreSQL | 5434 |
| Redis | 6380 |

---

## Geliştirme

```bash
pnpm dev                              # tüm paketler paralel (watch)
pnpm --filter @uai/runtime dev        # sadece runtime
pnpm test                             # tüm paketlerde vitest
pnpm test:mcp                         # MCP uçtan uca canlı test (stdio + HTTP)
pnpm mcp:serve                        # UAI'yi MCP sunucusu olarak sun
pnpm lint                             # tsc --noEmit (her pakette)
pnpm db:generate                      # migration üret
pnpm db:studio                        # Drizzle Studio
```

Ayrıntı ve mimari kararlar için → [`docs/`](./docs).

## Güvenlik

- `X-Api-Key` auth tüm `/api/*` rotalarında zorunlu (`UAI_API_KEY`).
- Gerçek `.env` **asla** commit'lenmez (`.gitignore`). Sadece `.env.example` paylaşılır.
- Bir açık bulursan lütfen public issue yerine doğrudan iletişime geç.

## Katkı

Katkılar memnuniyetle karşılanır — [CONTRIBUTING.md](./CONTRIBUTING.md) rehberine bak.
Issue açmadan önce mevcut issue'ları ara; PR'lar `pnpm lint` + `pnpm test` geçmeli.

## Lisans

[MIT](./LICENSE) © 2026 İhsan Deniz Tüfekci
