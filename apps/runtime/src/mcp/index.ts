import { logger } from '../logger.js';
import { ALL_TOOLS, TOOL_MAP } from '../tools/registry.js';
import { resolveMcpConfigs } from './config.js';
import { McpClient } from './client.js';
import { registerMcpTools } from './bridge.js';

export { McpClient } from './client.js';
export { resolveMcpConfig, resolveMcpConfigs, mcpEnabledForAgent } from './config.js';
export type { McpServerConfig, McpTransport } from './config.js';
export { getMcpStats, resetMcpStats, recordMcpCall } from './observability.js';
export type { McpStatsSnapshot, McpToolStat } from './observability.js';
export { createUaiMcpServer, bashAllowFromEnv, isBashAllowed } from './server.js';
export type { UaiMcpServerOptions } from './server.js';

/** Süreç boyunca yaşayan aktif MCP istemcileri (FAZ 2: N sunucu). */
const activeClients: McpClient[] = [];

/**
 * MCP alt sistemini başlatır. Ortamda MCP kapalıysa hiçbir şey yapmaz.
 *
 * ÖNEMLİ: Araçlar global TOOL_MAP'e köprülenir; bu fonksiyon start() içinde —
 * worker ajanlar (Brain/Arch/Front/Ops) `core.ts`'te görev başına oluşturulmadan
 * ÖNCE — çağrılmalıdır ki ajanlar araçları görebilsin. Ajan aboneliği FAZ 3.
 *
 * FAZ 2: Birden çok sunucu sırayla bağlanır. Biri başarısız olursa DİĞERLERİ
 * devam eder (kısmi başarısızlık toleransı) — MCP opsiyonel eklentidir, çekirdek
 * runtime'ı düşürmemeli.
 */
export async function initMcp(): Promise<void> {
  let configs;
  try {
    configs = resolveMcpConfigs();
  } catch (err) {
    // Yanlış yapılandırma (geçersiz MCP_SERVERS JSON, eksik komut/url) — görünür bırak, düşürme
    logger.error({ err }, 'MCP config hatası — MCP atlanıyor');
    return;
  }
  if (!configs.length) return; // MCP kapalı

  const seen = new Set<string>();
  let okServers = 0;
  let okTools = 0;

  for (const cfg of configs) {
    if (seen.has(cfg.name)) {
      logger.warn({ server: cfg.name }, 'MCP sunucu adı tekrarlı — atlanıyor (araç öneki çakışması)');
      continue;
    }
    seen.add(cfg.name);

    const client = new McpClient(cfg);
    try {
      await client.connect();
      const names = await registerMcpTools(client, { all: ALL_TOOLS, map: TOOL_MAP });
      activeClients.push(client);
      okServers++;
      okTools += names.length;
    } catch (err) {
      logger.error({ server: cfg.name, err }, 'MCP sunucusu başlatılamadı — atlanıyor');
      await client.close().catch(() => {});
    }
  }

  logger.info(
    { servers: okServers, total: configs.length, tools: okTools },
    'MCP initialized',
  );
}

/** Tüm aktif MCP istemcilerini kapatır (graceful shutdown). */
export async function shutdownMcp(): Promise<void> {
  await Promise.all(activeClients.map((c) => c.close().catch(() => {})));
  activeClients.length = 0;
}
