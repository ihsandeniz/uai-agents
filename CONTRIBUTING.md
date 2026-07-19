# Katkı Rehberi — UAI Agents Team

Teşekkürler! Bu proje açık kaynak (MIT) ve katkılara açık.

## Başlamadan

1. Bir issue aç ya da mevcut bir issue seç — büyük değişikliklerden önce niyetini paylaş.
2. Fork'la, feature dalı aç: `git checkout -b feature/kisa-aciklama`.
3. Kurulum: [README](./README.md) → Hızlı Başlangıç.

## Kod Standardı

- **TypeScript** — `any` yerine tipli kod; paylaşılan tipler `packages/shared`'da.
- Ajan iletişimi **in-process event bus** (`apps/runtime/src/bus/`) üzerinden — dış kuyruk ekleme.
- LLM erişimi yalnızca `apps/runtime/src/llm/` katmanından; sağlayıcıya özel kod sızdırma (BYOK korunur).
- Sır/anahtar **asla** commit'lenmez. Yeni değişken gerekiyorsa `.env.example`'a örnekle ekle.

## PR Öncesi Kontrol

```bash
pnpm lint     # tsc --noEmit — hata olmamalı
pnpm test     # vitest — yeşil olmalı
```

- Davranış değiştiren PR'lar test içermeli.
- Commit mesajları açıklayıcı olsun (tercihen `alan: özet` — ör. `runtime: webhook retry sınırı`).

## Hata & Güvenlik

- Normal hata → GitHub issue (repro adımları + beklenen/gerçekleşen).
- Güvenlik açığı → public issue **açma**, doğrudan iletişime geç.

## Lisans

Katkı göndererek, katkının [MIT lisansı](./LICENSE) altında yayınlanmasını kabul etmiş olursun.
