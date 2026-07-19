import { logger } from '../logger.js';

/**
 * MCP (Model Context Protocol) istemci yapılandırması — FAZ 2.
 *
 * İki kaynak birleştirilir (her ikisi de opsiyonel):
 *   1) Legacy tek-sunucu ortam değişkenleri (FAZ 1 uyumu) — stdio.
 *   2) MCP_SERVERS: JSON dizisi — çoklu sunucu, stdio + HTTP transport.
 *
 * Hiçbiri set değilse MCP kapalıdır ve mevcut davranış birebir korunur
 * (araç seti değişmez).
 *
 * Legacy ortam değişkenleri (tek stdio sunucu):
 *   MCP_ENABLED         — "1"/"true" ise legacy sunucu açılır
 *   MCP_SERVER_NAME     — takma ad; araç öneki (varsayılan: "mcp")
 *   MCP_SERVER_COMMAND  — çalıştırılacak komut  [MCP_ENABLED ise ZORUNLU]
 *   MCP_SERVER_ARGS     — argümanlar; tırnak-duyarlı ayrım
 *   MCP_INIT_TIMEOUT_MS — bağlantı+listeleme zaman aşımı (varsayılan: 15000)
 *
 * Çoklu sunucu (JSON dizisi):
 *   MCP_SERVERS='[
 *     {"name":"fs","transport":"stdio","command":"npx","args":["-y","@x/fs","/tmp"]},
 *     {"name":"remote","transport":"http","url":"https://h/mcp","headers":{"Authorization":"Bearer x"}}
 *   ]'
 */

export type McpTransport = 'stdio' | 'http';

export interface McpServerConfig {
  /** Araç önekinde kullanılan takma ad — mcp__<name>__<tool>. */
  name: string;
  /** Taşıma tipi. */
  transport: McpTransport;
  /** Bağlantı + tool listeleme için üst sınır (ms). */
  initTimeoutMs: number;
  // ── stdio ──
  /** Çalıştırılabilir komut (transport === 'stdio'). */
  command?: string;
  /** Komut argümanları (transport === 'stdio'). */
  args?: string[];
  /**
   * Alt sürece AÇIKÇA aktarılacak ek env değişkenleri (transport === 'stdio').
   * Güvenlik: process.env kör aktarılmaz — yalnızca burada listelenenler
   * (getDefaultEnvironment() PATH/HOME vb. üstüne) child'a geçer.
   */
  env?: Record<string, string>;
  // ── http ──
  /** Uzak MCP uç noktası (transport === 'http'). */
  url?: string;
  /** İstekle gönderilecek ek başlıklar (transport === 'http') — örn. Authorization. */
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Araç öneki için güvenli takma ad — yalnızca [a-z0-9_] bırak. */
function sanitizeName(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return cleaned || 'mcp';
}

/**
 * Argüman satırını tırnak-duyarlı parçalar. `"a b"` / `'a b'` tek argüman kalır.
 * Kapanmamış tırnak → kalan satır tek argüman sayılır (hata fırlatmaz).
 * Boş/whitespace → boş dizi.
 */
export function parseArgs(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

/**
 * Bir ajanın MCP araçlarına abone olup olmayacağını belirler (FAZ 3).
 * `MCP_AGENTS` env'i virgül/boşlukla ayrık ajan adları listesidir:
 *   - set değil / boş  → tüm ajanlar (varsayılan)
 *   - "none"           → hiçbiri
 *   - "all"            → tümü
 *   - "brain,ops"      → yalnızca listelenenler
 */
export function mcpEnabledForAgent(agent: string): boolean {
  const raw = process.env.MCP_AGENTS?.trim();
  if (!raw) return true;
  const set = raw.toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (set.includes('none')) return false;
  if (set.includes('all')) return true;
  return set.includes(agent.toLowerCase());
}

function coerceTimeout(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * Legacy tek stdio sunucusunu ortamdan çözer (FAZ 1 uyumu).
 * MCP_ENABLED yoksa → null. Açık ama komut eksikse → hata.
 */
export function resolveMcpConfig(): McpServerConfig | null {
  if (!isTruthy(process.env.MCP_ENABLED)) {
    logger.debug('MCP disabled (MCP_ENABLED not set)');
    return null;
  }

  const command = process.env.MCP_SERVER_COMMAND?.trim();
  if (!command) {
    throw new Error(
      'MCP_ENABLED açık ama MCP_SERVER_COMMAND boş. Örn: MCP_SERVER_COMMAND=npx ' +
        'MCP_SERVER_ARGS="-y @modelcontextprotocol/server-everything"',
    );
  }

  return {
    name: sanitizeName(process.env.MCP_SERVER_NAME ?? 'mcp'),
    transport: 'stdio',
    command,
    args: parseArgs(process.env.MCP_SERVER_ARGS),
    initTimeoutMs: coerceTimeout(process.env.MCP_INIT_TIMEOUT_MS),
  };
}

/** JSON dizisinden tek bir sunucu girdisini doğrular ve normalize eder. */
function validateEntry(raw: unknown, idx: number): McpServerConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`MCP_SERVERS[${idx}] bir nesne değil`);
  }
  const e = raw as Record<string, unknown>;
  const name = sanitizeName(typeof e.name === 'string' && e.name.trim() ? e.name : `mcp${idx}`);
  const transport: McpTransport = e.transport === 'http' ? 'http' : 'stdio';
  const initTimeoutMs = coerceTimeout(e.initTimeoutMs);

  if (transport === 'http') {
    const url = typeof e.url === 'string' ? e.url.trim() : '';
    if (!url) throw new Error(`MCP_SERVERS[${idx}] (${name}) transport=http ama url yok`);
    try {
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      throw new Error(`MCP_SERVERS[${idx}] (${name}) geçersiz url: ${url}`);
    }
    const headers =
      e.headers && typeof e.headers === 'object'
        ? Object.fromEntries(
            Object.entries(e.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          )
        : undefined;
    return { name, transport, url, headers, initTimeoutMs };
  }

  // stdio
  const command = typeof e.command === 'string' ? e.command.trim() : '';
  if (!command) throw new Error(`MCP_SERVERS[${idx}] (${name}) transport=stdio ama command yok`);
  const args = Array.isArray(e.args) ? e.args.map((a) => String(a)) : parseArgs(typeof e.args === 'string' ? e.args : undefined);
  const env =
    e.env && typeof e.env === 'object'
      ? Object.fromEntries(Object.entries(e.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined;
  return { name, transport, command, args, env, initTimeoutMs };
}

/**
 * Tüm MCP sunucu yapılandırmalarını çözer (legacy env + MCP_SERVERS JSON birleşik).
 * MCP kapalıysa boş dizi döner. Aynı ada sahip girdiler DE-DUP edilmez burada —
 * çağıran (index.ts) tekrar eden takma adı atlar (araç öneki çakışmasın diye).
 */
export function resolveMcpConfigs(): McpServerConfig[] {
  const configs: McpServerConfig[] = [];

  // 1) Legacy tek sunucu
  if (isTruthy(process.env.MCP_ENABLED)) {
    const legacy = resolveMcpConfig();
    if (legacy) configs.push(legacy);
  }

  // 2) MCP_SERVERS JSON dizisi
  const rawJson = process.env.MCP_SERVERS?.trim();
  if (rawJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`MCP_SERVERS geçerli JSON değil: ${msg}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error('MCP_SERVERS bir JSON dizisi olmalı (örn. [{...}])');
    }
    parsed.forEach((entry, i) => configs.push(validateEntry(entry, i)));
  }

  if (configs.length) {
    logger.info(
      { count: configs.length, servers: configs.map((c) => `${c.name}:${c.transport}`) },
      'MCP configs resolved',
    );
  } else {
    logger.debug('MCP disabled (ne MCP_ENABLED ne MCP_SERVERS set)');
  }
  return configs;
}
