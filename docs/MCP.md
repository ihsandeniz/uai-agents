# MCP (Model Context Protocol) Desteği

UAI Agents hem **MCP istemcisi** (dış MCP sunucularının araçlarını ajanlara
kazandırır) hem de **MCP sunucusu** (UAI'nin kendi yeteneklerini dış istemcilere
sunar) olarak çalışır. `@modelcontextprotocol/sdk` (TypeScript) üzerine kuruludur.

- **İstemci:** dış MCP sunucularının araçları `mcp__<sunucu>__<araç>` adıyla mevcut
  araç kaydına köprülenir; ajanlar bunları `<tool_call>` döngüsüyle çağırır.
- **Sunucu:** `uai_list_tools` / `uai_read_file` / `uai_search_web` / `uai_run_bash`
  araçlarını stdio veya HTTP (X-Api-Key) üzerinden dışa açar.

MCP tamamen **opsiyoneldir** — hiçbir env değişkeni set edilmezse davranış birebir
korunur (araç seti değişmez).

---

## 1. MCP İstemcisi — Dış Araçları Ajanlara Kazandırma

### 1a. Tek sunucu (legacy, stdio)

```bash
MCP_ENABLED=true
MCP_SERVER_NAME=filesystem                 # araç öneki → mcp__filesystem__*
MCP_SERVER_COMMAND=npx
MCP_SERVER_ARGS=-y @modelcontextprotocol/server-filesystem /tmp
MCP_INIT_TIMEOUT_MS=15000                   # bağlantı+listeleme zaman aşımı
```

`MCP_SERVER_ARGS` tırnak-duyarlı ayrıştırılır: `--path "a b"` tek argüman kalır.

### 1b. Çoklu sunucu (JSON — stdio + HTTP)

`MCP_SERVERS`, sunucu nesnelerinden oluşan bir JSON dizisidir. Legacy env ile
birlikte kullanılabilir (ikisi birleşir). Örnek → [`examples/mcp/mcp-servers.json`](../examples/mcp/mcp-servers.json).

```jsonc
[
  {
    "name": "filesystem",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    "env": { "SOME_TOKEN": "xyz" },        // yalnızca AÇIKÇA listelenen env child'a geçer
    "initTimeoutMs": 15000
  },
  {
    "name": "remote",
    "transport": "http",
    "url": "https://host.example/mcp",
    "headers": { "Authorization": "Bearer <token>" }
  }
]
```

**Davranış:**
- Sunucular sırayla bağlanır; **biri başarısız olursa diğerleri devam eder**
  (kısmi başarısızlık toleransı). MCP çekirdek runtime'ı asla düşürmez.
- Aynı ada sahip ikinci sunucu atlanır (araç öneki çakışmasını önlemek için).
- Bağlantı koparsa `callTool` **bir kez** otomatik yeniden bağlanıp tekrar dener.

### 1c. Hangi ajanlar MCP araçlarını görür?

Varsayılan: **tüm** worker ajanlar (brain/arch/front/ops). `MCP_AGENTS` ile kısıtla:

```bash
MCP_AGENTS=brain,ops    # yalnızca bunlar; "none" → hiçbiri, "all"/boş → tümü
```

> Not: Core ve QA ajanları MCP araçlarına abone olmaz (kasıtlı — worker odaklı).

### 1d. Araç köprüleme (JSON Schema → düz argüman)

MCP araçlarının JSON Schema girdisi UAI'nin düz-string argüman modeline indirgenir:

| JSON Schema | UAI argümanı | Notlar |
|---|---|---|
| string / number / integer / boolean | aynı tip | number/boolean geri-çevrilir |
| `enum` | string | izin verilen değerler açıklamaya yazılır |
| `object` / `array` | string (JSON) | LLM JSON verir → `JSON.parse` |
| `oneOf` / `anyOf` / `allOf` | string (JSON) | belirsiz tip → JSON fallback |

---

## 2. MCP Sunucusu — UAI'yi Dışa Sunma

UAI'nin araçlarını dış MCP istemcilerine (ör. Claude Code, başka bir ajan) sunar.

```bash
pnpm mcp:serve                       # stdio (varsayılan — yerel güven)
MCP_SERVE_TRANSPORT=http pnpm mcp:serve   # HTTP (StreamableHTTP + X-Api-Key)
```

### Sunulan araçlar (dar güvenlik duruşu)

| Araç | Açıklama | Risk |
|---|---|---|
| `uai_list_tools` | Yerel araç kaydını listeler | salt-okunur |
| `uai_read_file` | Dosya okur | salt-okunur |
| `uai_search_web` | DuckDuckGo araması | düşük |
| `uai_run_bash` | Kabuk komutu — **yalnızca allowlist** | kontrollü |

- **`writeFile` DIŞA AÇILMAZ** (dosya yazımı dışarıya verilmez).
- `uai_run_bash` yalnızca `MCP_SERVER_BASH_ALLOW` öneklerine uyan komutları
  çalıştırır; **varsayılan hepsi reddedilir**:

```bash
MCP_SERVER_BASH_ALLOW="git status,ls,cat"   # bu öneklerle başlayan komutlar
```

Eşleşme kelime-sınırlıdır: `ls` izni `lsof`'u açmaz.

### HTTP transport + auth

```bash
MCP_SERVE_TRANSPORT=http
MCP_SERVE_PORT=3100                 # varsayılan 3100
MCP_SERVE_API_KEY=<gizli>           # yoksa UAI_API_KEY; set ise X-Api-Key ZORUNLU
```

İstemci `X-Api-Key: <gizli>` başlığı göndermezse **401** alır.

### Claude Code ile kullanım

`examples/mcp/claude-code-config.json` dosyasındaki gibi UAI'yi bir MCP sunucusu
olarak Claude Code'a tanıtabilirsin (stdio).

---

## 3. Gözlemlenebilirlik (Observability)

Her MCP araç çağrısı (istemci ve sunucu tarafı) süre + sonuç olarak sayaçlanır ve
yapılandırılmış log basar: `{ mcp: true, server, tool, durationMs, ok, argKeys }`.

```ts
import { getMcpStats } from './mcp/index.js';
getMcpStats(); // { totalCalls, totalErrors, byTool: { "server__tool": {calls,errors,totalMs,lastMs} } }
```

---

## 4. Entegrasyon Testi

Uçtan uca canlı test (yerel fixture'lara gerçek stdio + HTTP bağlantısı,
reconnect, ajan aboneliği, observability, dışa-sunum + auth):

```bash
pnpm test:mcp     # 60+ assertion; harici ağ/servis gerektirmez
```

---

## 5. Env Değişkenleri Özeti

| Değişken | Rol |
|---|---|
| `MCP_ENABLED` | Legacy tek stdio sunucusunu açar |
| `MCP_SERVER_NAME` / `_COMMAND` / `_ARGS` / `MCP_INIT_TIMEOUT_MS` | Legacy sunucu ayarı |
| `MCP_SERVERS` | Çoklu sunucu (JSON dizisi, stdio + http) |
| `MCP_AGENTS` | Hangi ajanlar MCP araçlarına abone (boş=tümü / csv / none / all) |
| `MCP_SERVER_BASH_ALLOW` | `uai_run_bash` allowlist önekleri (MCP sunucusu) |
| `MCP_SERVE_TRANSPORT` / `_PORT` / `_API_KEY` | UAI MCP sunucusu (stdio\|http) ayarı |
