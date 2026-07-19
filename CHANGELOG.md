# Changelog

Bu projedeki tüm önemli değişiklikler bu dosyada belgelenir.
Format [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) esas alır;
sürümleme [Semantic Versioning](https://semver.org/lang/tr/) izler.

## [Unreleased]

### Planlanan
- MCP (Model Context Protocol) sunucu/araç desteği
- OpenTelemetry tabanlı tracing & observability
- Adım/token streaming (SSE/WebSocket)
- `examples/` klasörü + docs sitesi

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

[Unreleased]: https://github.com/ihsandeniz/uai-agents/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ihsandeniz/uai-agents/releases/tag/v0.1.0
