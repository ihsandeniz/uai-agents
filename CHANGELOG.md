# Changelog

Bu projedeki tüm önemli değişiklikler bu dosyada belgelenir.
Format [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) esas alır;
sürümleme [Semantic Versioning](https://semver.org/lang/tr/) izler.

## [Unreleased]

## [0.2.0] - 2026-08-11

### Added
- **MCP (Model Context Protocol) — istemci + sunucu** (2026-07-19, `93e57b6`): dış MCP
  sunucularının araçları ajanlara köprülenir (stdio + HTTP, çoklu sunucu, reconnect,
  `MCP_AGENTS` aboneliği, observability sayaçları); UAI'nin kendisi de `pnpm mcp:serve` ile
  MCP sunucusu olarak sunulur (`uai_run_bash` allowlist'li, `writeFile` dışa kapalı).
  Uçtan uca canlı test `pnpm test:mcp` → 70/70. Ayrıntı: `docs/MCP.md`
- **`examples/` klasörü** (2026-07-19): `examples/mcp/` — `mcp-servers.json`,
  `claude-code-config.json`, `mcp.env.sample`
- **İngilizce README + dil geçişi** (2026-07-24, `6ab764b`)
- **Kurulum sihirbazı `pnpm setup`** (2026-07-24, `1463ce6`): sıfır-bağımlılık, cross-platform;
  ayrıca `pnpm start` Windows uyumluluğu (`sleep 2` → `docker compose --wait`)
- **Dashboard "Calm Pro Console" yeniden tasarımı + canlı MCP paneli** (2026-07-19, `f6059d7`)

### Changed
- **Embedding artık BYOK katmanının içinde** (2026-08-11): `embed()` seçilen sağlayıcıdan
  bağımsız olarak `api.openai.com`'a gidiyordu ve `OPENAI_API_KEY` yoksa **sessizce** boş vektör
  dönüyordu — yani önerilen `LLM_PROVIDER=ollama` kurulumunda pgvector semantik hafıza hiç
  çalışmıyor ama hiçbir yerde görünmüyordu. Yeni `resolveEmbedProvider()` sağlayıcıdan türetir,
  `EMBED_BASE_URL`/`EMBED_MODEL`/`EMBED_API_KEY`/`EMBED_DIMENSIONS` ile ezilebilir,
  `EMBED_ENABLED=false` ile kapatılabilir. Boyut uyuşmazlığı (`vector(1536)`) artık **çağrı
  anında değil çözümleme anında** yakalanır. Kapalıysa açılışta `WARN` basılır. 12 yeni test.
- **CI ilk kez kodu test ediyor**: `.github/workflows/ci.yml` — lint → test → MCP → build.
  Önceki tek workflow yalnızca bağımlılık taramasıydı.
- **Öğrenen yönlendirmeye üstel zaman decay'i** (2026-08-07, `c2c418b`): yönlendirme skoru
  `score · 2^(-Δt/halfLife)` ile eskiyor; `halfLifeDays <= 0` decay'i kapatır. Migration
  gerekmez (`createdAt` null eski satırlar okunur). 12 birim test.

### Fixed
- **Kök `pnpm test` artık geçiyor** (2026-08-11): `@uai/db` + `@uai/shared` paketlerinde
  `vitest run` script'i vardı ama hiç test dosyası yoktu → vitest exit 1 → kök test komutu
  **kimsenin geçemeyeceği bir kapıydı**, üstelik README+CONTRIBUTING onu şart koşuyordu.
  Gerçek testler yazıldı: şema sözleşmeleri (14) + şema↔migration **drift nöbetçisi** (8).
  Toplam **46 test**.
- **`memory_embedding_idx` drizzle şemasına alındı** (2026-08-11): HNSW indeksi yalnız ham
  SQL'de tanımlıydı, drizzle'ın görüş alanı dışındaydı — sessizce düşürülebilirdi.
  `0004_memory_embedding_idx` idempotent (`IF NOT EXISTS`), mevcut DB'yi kırmaz.
- **Öğrenme paneli boş durumda kayboluyordu** (2026-08-11): decay eklendikten sonra yalnız
  eski kaydı olan ajanlar `/api/learning`'den düşüyor, panel de tamamen ortadan kayboluyordu.
  Artık MCP paneli gibi kendini açıklayan bir boş durum gösteriyor.
- **`pnpm db:rls`** (2026-08-11): RLS politikalarını uygulama yolu yalnız bir SQL yorumunda
  yazılıydı; artık script + README bölümü. (Politikalar hâlâ journal dışı — bilinçli.)
- **Test dosyaları `dist/`e derlenmiyor** (2026-08-11): build ayrı `tsconfig.build.json`
  kullanıyor; lint hâlâ ana tsconfig ile testleri **tip kontrolünden geçiriyor**.
- **33 bağımlılık açığı kapatıldı** (2026-08-08, `fdb0a51`): 16 high dahil; `pnpm audit` → 0.
  `pnpm.onlyBuiltDependencies` sessizce ölüydü (pnpm 10.33 `package.json`'daki `pnpm` alanını
  okumuyor) → `pnpm-workspace.yaml`'a taşındı
- **Drizzle migration drift** (2026-08-08, `bcccaba`): eksik olan migration değil,
  `db/migrations/meta/` altındaki 0002 + 0003 snapshot'larıydı. RLS dosyası
  `0004_rls_policies.sql` → `db/migrations/manual/rls_policies.sql`'e taşındı (aynı klasörde
  biri uygulanan biri uygulanmayan iki `0004_` tuzağı)

### Planlanan
- OpenTelemetry tabanlı **tracing** (Prometheus metrikleri ilk sürümden beri var — eksik olan
  span/trace katmanı)
- Adım/token streaming (SSE/WebSocket)
- Orchestrator / TaskQueue / MCP bridge için birim test kapsamı (şu an bu modüllerin doğrudan
  vitest testi yok; MCP uçtan uca `test:mcp` ile koşuluyor)
- Docs sitesi
- Sürüm etiketleme: `package.json` sürümleri hâlâ `0.0.1`, `v0.1.0` tag'i atılmamış

## [0.1.0] - 2026-07-19

İlk **public** sürüm — proje MIT lisansıyla açık kaynak yapıldı.

### Added
- **Açık kaynak** — MIT `LICENSE`, public'e uygun `README`, `CONTRIBUTING.md`
- **LLM BYOK** — `LLM_PROVIDER` ile OpenRouter / OpenAI / Gemini / Ollama / custom arası
  `.env` üzerinden geçiş; tek OpenAI-uyumlu istek katmanı (`apps/runtime/src/llm/`)
- **pgvector otomatik init** — `db/init/00-extensions.sql` compose'a mount, ilk init'te otomatik

### Öne çıkan mevcut yetenekler (Faz 0-15 birikimi)
- 6 ajanlı orkestrasyon (1 core lider + brain/arch/front/ops/qa)
- Core ajanın görevi otomatik uzman ajana yönlendirmesi + QA doğrulama
- Semantik hafıza (pgvector) + öğrenen yönlendirme (ajan performansı kalıcı, zamanla iyileşir)
- DAG tabanlı paralellik + deadlock koruması
- Webhook entegrasyonu (5 hatadan sonra otomatik devre dışı)
- Away mode — insan onay kuyruğu, saat/gün bazlı duraklat/sürdür
- In-process event bus (dış kuyruk sistemi yok)
- `X-Api-Key` auth tüm `/api/*` rotalarında
- Next.js 15 dashboard, Docker ile tek-komut altyapı

### Security
- Docker portları `127.0.0.1`'e sabitlendi
- Bağımlılık açıkları kapatıldı (next 15.5.20, drizzle-orm 0.45.2)

<!-- 2026-08-11: `v0.1.0` tag'i hiç atılmamıştı (compare linki 404 veriyordu). Bu tarihte
     0.1.0, içeriğinin yazıldığı `1aad2dd` commit'ine geriye dönük etiketlendi; bu tur
     0.2.0 olarak kesildi ve paket sürümleri 0.2.0'a çekildi. -->
[Unreleased]: https://github.com/ihsandeniz/uai-agents/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ihsandeniz/uai-agents/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ihsandeniz/uai-agents/releases/tag/v0.1.0
[0.1.0]: https://github.com/ihsandeniz/uai-agents/releases/tag/v0.1.0
