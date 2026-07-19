import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from '../logger.js';
import { ALL_TOOLS, readFileTool, searchWebTool, runBashTool } from '../tools/registry.js';
import { recordMcpCall } from './observability.js';

/**
 * MCP SERVER — UAI'nin kendi yeteneklerini dış MCP istemcilerine sunar (FAZ 4).
 *
 * Güvenlik duruşu (kasıtlı olarak dar):
 *   - Salt-okunur / düşük-risk araçlar açık: uai_list_tools, uai_read_file, uai_search_web
 *   - uai_run_bash yalnızca ALLOWLIST önekleriyle çalışır (varsayılan: hepsi RED)
 *   - writeFile DIŞA AÇILMAZ (dosya yazımı dışarıya verilmez)
 *   - Görev gönderimi (uai_submit_task) yalnızca onSubmitTask enjekte edilirse açılır
 *
 * Taşıma (stdio / HTTP) + auth entrypoint'te bağlanır (scripts/uai-mcp-server.ts).
 */

export interface UaiMcpServerOptions {
  /**
   * uai_run_bash için izin verilen komut önekleri (ör. ["git status", "ls", "cat"]).
   * Boş/verilmemiş → uai_run_bash TÜM komutları reddeder (güvenli varsayılan).
   */
  bashAllow?: string[];
  /**
   * Görev gönderme geri çağrısı. Verilirse `uai_submit_task` aracı açılır;
   * verilmezse orkestrasyona erişim dışa sunulmaz (queue/DB bağımlılığı gerektirmez).
   */
  onSubmitTask?: (goal: string) => Promise<string>;
}

/** `MCP_SERVER_BASH_ALLOW` env'inden allowlist önekleri (virgülle ayrık). */
export function bashAllowFromEnv(): string[] {
  const raw = process.env.MCP_SERVER_BASH_ALLOW?.trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Komut allowlist'e uyuyor mu — tam eşleşme veya "<önek> " ile başlama (kelime sınırı). */
export function isBashAllowed(command: string, allow: string[]): boolean {
  if (!allow.length) return false;
  const c = command.trim();
  return allow.some((p) => c === p || c.startsWith(`${p} `));
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/** UAI yeteneklerini sunan yapılandırılmış bir McpServer üretir. */
export function createUaiMcpServer(opts: UaiMcpServerOptions = {}): McpServer {
  const bashAllow = opts.bashAllow ?? [];
  const server = new McpServer({ name: 'uai-agents', version: '0.1.0' });

  // Süreyi ölç + observability'e kaydet (istemci tarafıyla simetrik gözlemlenebilirlik)
  const timed = async (tool: string, fn: () => Promise<string>) => {
    const started = Date.now();
    try {
      const out = await fn();
      recordMcpCall({ server: 'uai-agents', tool, durationMs: Date.now() - started, ok: true });
      return textResult(out);
    } catch (err) {
      recordMcpCall({ server: 'uai-agents', tool, durationMs: Date.now() - started, ok: false });
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ tool, err: msg }, 'uai mcp server tool failed');
      return textResult(`Error: ${msg}`);
    }
  };

  // uai_list_tools — UAI'nin yerel araç kaydını listeler (mcp__ köprülü olanlar hariç)
  server.registerTool(
    'uai_list_tools',
    { description: 'UAI çalışma zamanının sunduğu yerel araçları (ad + açıklama) listeler.', inputSchema: {} },
    async () =>
      timed('uai_list_tools', async () => {
        const local = ALL_TOOLS.filter((t) => !t.name.startsWith('mcp__')).map((t) => ({
          name: t.name,
          description: t.description,
        }));
        return JSON.stringify(local, null, 2);
      }),
  );

  // uai_read_file — salt-okunur dosya erişimi
  server.registerTool(
    'uai_read_file',
    {
      description: 'Yerel dosya sisteminden bir dosyayı okur (salt-okunur).',
      inputSchema: { path: z.string().describe('Okunacak dosya yolu') },
    },
    async ({ path }) => timed('uai_read_file', () => readFileTool.execute({ path })),
  );

  // uai_search_web — web araması
  server.registerTool(
    'uai_search_web',
    {
      description: 'DuckDuckGo ile web araması yapar ve özet döndürür.',
      inputSchema: { query: z.string().describe('Arama sorgusu') },
    },
    async ({ query }) => timed('uai_search_web', () => searchWebTool.execute({ query })),
  );

  // uai_run_bash — ALLOWLIST'li kabuk komutu (varsayılan hepsi RED)
  server.registerTool(
    'uai_run_bash',
    {
      description:
        'Kabuk komutu çalıştırır — YALNIZCA sunucu allowlist önekleriyle. İzin yoksa reddedilir.',
      inputSchema: { command: z.string().describe('Çalıştırılacak komut (allowlist önekiyle başlamalı)') },
    },
    async ({ command }) =>
      timed('uai_run_bash', async () => {
        if (!isBashAllowed(command, bashAllow)) {
          return `Error: komut allowlist'te değil — reddedildi. İzinli önekler: ${bashAllow.length ? bashAllow.join(', ') : '(yok)'}`;
        }
        return runBashTool.execute({ command });
      }),
  );

  // uai_submit_task — yalnızca orkestrasyon geri çağrısı enjekte edilirse
  if (opts.onSubmitTask) {
    const submit = opts.onSubmitTask;
    server.registerTool(
      'uai_submit_task',
      {
        description: 'UAI orkestratörüne bir görev gönderir ve görev kimliği/sonucu döner.',
        inputSchema: { goal: z.string().describe('Görev hedefi') },
      },
      async ({ goal }) => timed('uai_submit_task', () => submit(goal)),
    );
  }

  const toolCount = 4 + (opts.onSubmitTask ? 1 : 0);
  logger.info({ tools: toolCount, bashAllow }, 'UAI MCP server oluşturuldu');
  return server;
}
