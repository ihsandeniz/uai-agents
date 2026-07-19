import { logger } from '../logger.js';
import type { ToolDefinition, ToolArgDef } from '../tools/types.js';
import type { McpClient, McpToolInfo } from './client.js';
import { recordMcpCall } from './observability.js';

/**
 * MCP araçlarını UAI'nin mevcut tool sistemine köprüler (FAZ 2).
 *
 * UAI araçları DÜZ string argümanlar kullanır (Record<string,string>) ve LLM'e
 * metin şeması olarak enjekte edilir. MCP araçları ise JSON Schema kullanır.
 * Her üst-seviye özelliği bir düz argümana indirger, string olarak alıp MCP'ye
 * göndermeden önce şema tipine geri çeviririz.
 *
 * FAZ 2 kapsamı (tam JSON Schema köprüsü):
 *   - scalar: string / number(integer) / boolean
 *   - enum:   string (izin verilen değerler açıklamaya yazılır)
 *   - object / array:        JSON string arg → execute'ta JSON.parse
 *   - oneOf / anyOf / allOf:  belirsiz tip → JSON string arg (fallback)
 */

const PREFIX_SEP = '__';

/** mcp__<server>__<tool> — tool-loop'un ürettiği çağrı adıyla eşleşir. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp${PREFIX_SEP}${serverName}${PREFIX_SEP}${toolName}`;
}

/** Bir argümanın MCP'ye giderken nasıl çözüleceğini belirten iç sınıflandırma. */
type CoerceKind = 'string' | 'number' | 'boolean' | 'json';

interface ArgPlan {
  /** LLM'e gösterilen UAI tipi (yalnızca string/number/boolean vardır). */
  uaiType: ToolArgDef['type'];
  /** MCP'ye göndermeden önce uygulanan dönüşüm. */
  coerce: CoerceKind;
  /** Açıklamaya eklenecek ipucu (enum değerleri, "JSON ver" vb.). */
  hint: string;
}

interface JsonSchemaProp {
  type?: unknown;
  description?: string;
  enum?: unknown[];
  oneOf?: unknown;
  anyOf?: unknown;
  allOf?: unknown;
}

/** Bir JSON Schema özelliğini UAI argüman planına indirger. */
function planProp(schema: JsonSchemaProp): ArgPlan {
  // 1) enum → izin listesi (tip enum değerlerinden çıkarılır)
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const allBool = schema.enum.every((v) => typeof v === 'boolean');
    const allNum = schema.enum.every((v) => typeof v === 'number');
    const uaiType: ToolArgDef['type'] = allBool ? 'boolean' : allNum ? 'number' : 'string';
    return {
      uaiType,
      coerce: allBool ? 'boolean' : allNum ? 'number' : 'string',
      hint: ` (izin verilen: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')})`,
    };
  }

  // 2) belirsiz birleşim (oneOf/anyOf/allOf) ve tip yok → JSON string
  if (schema.oneOf || schema.anyOf || schema.allOf) {
    return { uaiType: 'string', coerce: 'json', hint: ' (JSON değeri olarak ver)' };
  }

  // 3) nested object / array → JSON string
  const t = schema.type;
  if (t === 'object' || t === 'array') {
    return {
      uaiType: 'string',
      coerce: 'json',
      hint: t === 'array' ? ' (JSON dizisi olarak ver, örn. ["a","b"])' : ' (JSON nesnesi olarak ver, örn. {"k":"v"})',
    };
  }

  // 4) scalar
  if (t === 'number' || t === 'integer') return { uaiType: 'number', coerce: 'number', hint: '' };
  if (t === 'boolean') return { uaiType: 'boolean', coerce: 'boolean', hint: '' };
  return { uaiType: 'string', coerce: 'string', hint: '' };
}

/** Düz string argümanı MCP'nin beklediği JSON tipine çevirir. */
function coerceValue(value: string, kind: CoerceKind): unknown {
  if (kind === 'number') {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (kind === 'boolean') return value === 'true' || value === '1';
  if (kind === 'json') {
    try {
      return JSON.parse(value);
    } catch {
      // Geçersiz JSON → ham string gönder; sunucu şema hatasını kendisi bildirir
      logger.warn({ value }, 'MCP arg JSON parse edilemedi — ham string gönderiliyor');
      return value;
    }
  }
  return value;
}

/** Tek bir MCP aracını UAI ToolDefinition'a dönüştürür. */
export function toToolDefinition(client: McpClient, info: McpToolInfo): ToolDefinition {
  const props = info.inputSchema.properties ?? {};
  const required = new Set(info.inputSchema.required ?? []);

  const args: Record<string, ToolArgDef> = {};
  const plans: Record<string, ArgPlan> = {};

  for (const [key, rawSchema] of Object.entries(props)) {
    const schema = (rawSchema ?? {}) as JsonSchemaProp;
    const plan = planProp(schema);
    plans[key] = plan;
    args[key] = {
      type: plan.uaiType,
      description: (schema.description ?? `MCP argümanı (${info.name})`) + plan.hint,
      required: required.has(key),
    };
  }

  const fullName = mcpToolName(client.serverName, info.name);

  return {
    name: fullName,
    description: `[MCP:${client.serverName}] ${info.description || info.name}`,
    args,
    async execute(raw) {
      // Düz string argümanları şema tipine geri çevir (bilinmeyen anahtar → ham geçer)
      const payload: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(raw)) {
        payload[key] = plans[key] ? coerceValue(val, plans[key].coerce) : val;
      }
      // Yapılandırılmış gözlemlenebilirlik: süre + sonuç her çağrıda kaydedilir
      const started = Date.now();
      try {
        const out = await client.callTool(info.name, payload);
        const durationMs = Date.now() - started;
        // MCP tool error: öneki araç-seviyesi hatayı gösterir (istisna değil)
        const ok = !out.startsWith('MCP tool error:');
        recordMcpCall({ server: client.serverName, tool: info.name, durationMs, ok });
        logger.info(
          { mcp: true, server: client.serverName, tool: info.name, durationMs, ok, argKeys: Object.keys(payload) },
          'mcp tool call',
        );
        return out;
      } catch (err) {
        const durationMs = Date.now() - started;
        const msg = err instanceof Error ? err.message : String(err);
        recordMcpCall({ server: client.serverName, tool: info.name, durationMs, ok: false });
        logger.warn({ mcp: true, server: client.serverName, tool: info.name, durationMs, ok: false, err: msg }, 'mcp tool call failed');
        return `Error: MCP aracı '${fullName}' çağrısı başarısız — ${msg}`;
      }
    },
  };
}

/**
 * Bir MCP istemcisinin tüm araçlarını UAI kayıt haritasına köprüler.
 * Ada çakışması olursa (aynı önekli araç zaten varsa) uyarır ve atlar —
 * mevcut yerel araçların (readFile vb.) üzerine YAZMAZ.
 *
 * @returns köprülenen araç isimleri
 */
export async function registerMcpTools(
  client: McpClient,
  registry: { all: ToolDefinition[]; map: Map<string, ToolDefinition> },
): Promise<string[]> {
  const tools = await client.listTools();
  const registered: string[] = [];

  for (const info of tools) {
    const def = toToolDefinition(client, info);
    if (registry.map.has(def.name)) {
      logger.warn({ tool: def.name }, 'MCP tool adı zaten kayıtlı — atlandı');
      continue;
    }
    registry.map.set(def.name, def);
    registry.all.push(def);
    registered.push(def.name);
  }

  logger.info(
    { server: client.serverName, count: registered.length, tools: registered },
    'MCP tools registered',
  );
  return registered;
}
