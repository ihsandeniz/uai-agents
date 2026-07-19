import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { logger } from '../logger.js';
import type { McpServerConfig } from './config.js';

/** Bir MCP aracının UAI için gereken minimum tanımı. */
export interface McpToolInfo {
  name: string;
  description: string;
  /** JSON Schema (type: object) — köprüleme bridge.ts'te yapılır. */
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

/**
 * Tek bir MCP sunucusuna bağlanan ince istemci sarmalayıcı (FAZ 2).
 *
 * Yaşam döngüsü:  new McpClient(cfg) → connect() → listTools()/callTool() → close()
 *
 * FAZ 2 eklentileri:
 *   - stdio + HTTP (StreamableHTTP) transport (cfg.transport'a göre)
 *   - callTool bağlantı-kopması hatasında BİR kez yeniden bağlanıp tekrar dener
 */
export class McpClient {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private connected = false;
  /** close() çağrıldı mı — yeniden bağlanma denemesini engeller. */
  private closing = false;

  constructor(private readonly cfg: McpServerConfig) {}

  get serverName(): string {
    return this.cfg.name;
  }

  get transportKind(): McpServerConfig['transport'] {
    return this.cfg.transport;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** stdio alt-sürecinin pid'i (yalnızca transport === 'stdio', bağlıyken). */
  get pid(): number | null {
    return (this.transport as { pid?: number | null } | null)?.pid ?? null;
  }

  /** cfg.transport'a göre yeni bir transport örneği kurar. */
  private buildTransport(): Transport {
    if (this.cfg.transport === 'http') {
      if (!this.cfg.url) {
        throw new Error(`MCP '${this.cfg.name}' transport=http ama url yok`);
      }
      return new StreamableHTTPClientTransport(new URL(this.cfg.url), {
        requestInit: this.cfg.headers ? { headers: this.cfg.headers } : undefined,
      });
    }
    if (!this.cfg.command) {
      throw new Error(`MCP '${this.cfg.name}' transport=stdio ama command yok`);
    }
    return new StdioClientTransport({
      command: this.cfg.command,
      args: this.cfg.args ?? [],
      // Güvenli env: yalnızca açıkça verilen env, getDefaultEnvironment (PATH/HOME) üstüne
      env: this.cfg.env ? { ...getDefaultEnvironment(), ...this.cfg.env } : undefined,
      // stderr'i inherit et — sunucu logları görünür kalsın, stdout protokol için ayrılır
      stderr: 'inherit',
    });
  }

  /** Transport+client kurar ve handshake yapar (connect/reconnect ortak yolu). */
  private async establish(): Promise<void> {
    this.transport = this.buildTransport();
    this.client = new Client({ name: 'uai-runtime', version: '0.1.0' }, { capabilities: {} });

    await this.withTimeout(
      this.client.connect(this.transport),
      `MCP '${this.cfg.name}' sunucusuna bağlanılamadı (${this.cfg.transport})`,
    );
    this.connected = true;
  }

  /**
   * Sunucuya bağlanır ve MCP handshake'ini tamamlar.
   * initTimeoutMs içinde bağlanamazsa hata fırlatır (asılı kalmaz).
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.closing = false;
    await this.establish();
    logger.info({ server: this.cfg.name, transport: this.cfg.transport }, 'MCP client connected');
  }

  /**
   * Bağlantıyı yeniden kurar (dayanıklılık). Eski client'ı sessizce kapatır,
   * yenisini kurar. close() sonrası çağrılmaz.
   */
  private async reconnect(): Promise<void> {
    if (this.closing) throw new Error(`MCP '${this.cfg.name}' kapanıyor — reconnect iptal`);
    logger.warn({ server: this.cfg.name }, 'MCP yeniden bağlanılıyor');
    this.connected = false;
    try {
      await this.client?.close();
    } catch {
      /* eski bağlantı zaten ölü olabilir — yoksay */
    }
    this.client = null;
    this.transport = null;
    await this.establish();
    logger.info({ server: this.cfg.name }, 'MCP yeniden bağlandı');
  }

  /** Sunucunun sunduğu araçları listeler. connect() önce çağrılmalı. */
  async listTools(): Promise<McpToolInfo[]> {
    if (!this.client || !this.connected) {
      throw new Error(`MCP '${this.cfg.name}' bağlı değil — önce connect() çağır.`);
    }
    const res = await this.withTimeout(
      this.client.listTools(),
      `MCP '${this.cfg.name}' araç listesi alınamadı`,
    );
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as McpToolInfo['inputSchema'],
    }));
  }

  /**
   * Uzak aracı çağırır ve içerik bloklarını tek düz metne indirger.
   * Bağlantı koptuysa BİR kez yeniden bağlanıp tekrar dener (dayanıklılık).
   * Araç seviyesinde hata (isError) düz metin olarak döner — tool-loop'u bozmaz.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client || !this.connected) {
      throw new Error(`MCP '${this.cfg.name}' bağlı değil — önce connect() çağır.`);
    }
    let res;
    try {
      res = await this.client.callTool({ name, arguments: args });
    } catch (err) {
      if (this.closing || !isConnectionError(err)) throw err;
      // Bağlantı kopması — bir kez yeniden bağlan ve tekrar dene
      await this.reconnect();
      res = await this.client!.callTool({ name, arguments: args });
    }

    const content = Array.isArray(res.content) ? res.content : [];
    const text = content
      .map((c) => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image' || c.type === 'audio') return `[${c.type}: ${c.mimeType}]`;
        return `[${c.type}]`;
      })
      .filter(Boolean)
      .join('\n');

    const body = text || '(boş yanıt)';
    return res.isError ? `MCP tool error: ${body}` : body;
  }

  /** Alt-süreci / bağlantıyı kapatır. İdempotent. */
  async close(): Promise<void> {
    this.closing = true;
    if (!this.connected) return;
    this.connected = false;
    try {
      await this.client?.close();
    } catch (err) {
      logger.warn({ server: this.cfg.name, err }, 'MCP client close error (yoksayıldı)');
    }
    this.client = null;
    this.transport = null;
    logger.info({ server: this.cfg.name }, 'MCP client closed');
  }

  private withTimeout<T>(p: Promise<T>, msg: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${msg} — ${this.cfg.initTimeoutMs}ms zaman aşımı`)), this.cfg.initTimeoutMs),
      ),
    ]);
  }
}

/** Hatanın bağlantı kopmasından kaynaklanıp kaynaklanmadığını sezgisel belirler. */
function isConnectionError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('connection closed') ||
    msg.includes('not connected') ||
    msg.includes('econnreset') ||
    msg.includes('epipe') ||
    msg.includes('socket hang up') ||
    msg.includes('transport') ||
    msg.includes('closed')
  );
}
