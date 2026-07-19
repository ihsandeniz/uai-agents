# Güvenlik Politikası

## Desteklenen sürümler

Proje aktif geliştirme aşamasındadır; güvenlik düzeltmeleri `main` dalına uygulanır.

| Sürüm | Destek |
|-------|--------|
| 0.1.x | ✅ |
| < 0.1 | ❌ |

## Açık bildirimi

Bir güvenlik açığı bulursan **lütfen public issue AÇMA.** Bunun yerine:

1. GitHub üzerinden **private güvenlik uyarısı** aç:
   [Report a vulnerability](https://github.com/ihsandeniz/uai-agents/security/advisories/new)
2. Şunları ekle: etkilenen bileşen, yeniden üretme adımları, olası etki ve (varsa) düzeltme önerisi.

Makul sürede yanıt vermeye ve düzeltmeyi koordineli şekilde yayınlamaya çalışırız.
Sorumlu bildirim yapan araştırmacılara, isterlerse, teşekkür notunda yer verilir.

## Kapsam / notlar

- Gerçek `.env` **asla** commit'lenmez; yalnızca `.env.example` paylaşılır.
- `X-Api-Key` auth tüm `/api/*` rotalarında zorunludur (`UAI_API_KEY`).
- Docker portları `127.0.0.1`'e sabitlenmiştir — dışa açmadan önce güvenlik değerlendirmesi yap.
- Kendi anahtarını getir (BYOK): LLM sağlayıcı anahtarların yalnızca senin `.env`'inde durur, repoya girmez.
