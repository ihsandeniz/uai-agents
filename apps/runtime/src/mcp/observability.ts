/**
 * MCP gözlemlenebilirlik (observability) temeli — FAZ 3.
 *
 * Süreç-içi hafif sayaçlar: her MCP araç çağrısının sonucu (süre, başarı/hata)
 * araç bazında toplanır. Yapılandırılmış log ile birlikte, MCP kullanımının
 * dışa açık bir stats görünümünü (ör. bir /metrics veya CLI komutu — FAZ 4/5)
 * beslemek için temel sağlar.
 */

export interface McpToolStat {
  /** Toplam çağrı sayısı. */
  calls: number;
  /** Hata (isError / exception) ile sonuçlanan çağrı sayısı. */
  errors: number;
  /** Toplam süre (ms) — ortalama = totalMs / calls. */
  totalMs: number;
  /** Son çağrının süresi (ms). */
  lastMs: number;
}

export interface McpStatsSnapshot {
  totalCalls: number;
  totalErrors: number;
  /** `<server>__<tool>` → istatistik. */
  byTool: Record<string, McpToolStat>;
}

const byTool = new Map<string, McpToolStat>();
let totalCalls = 0;
let totalErrors = 0;

/** Bir MCP araç çağrısının sonucunu kaydeder (bridge.execute tarafından çağrılır). */
export function recordMcpCall(input: { server: string; tool: string; durationMs: number; ok: boolean }): void {
  const key = `${input.server}__${input.tool}`;
  const stat = byTool.get(key) ?? { calls: 0, errors: 0, totalMs: 0, lastMs: 0 };
  stat.calls++;
  if (!input.ok) stat.errors++;
  stat.totalMs += input.durationMs;
  stat.lastMs = input.durationMs;
  byTool.set(key, stat);

  totalCalls++;
  if (!input.ok) totalErrors++;
}

/** Anlık istatistik görüntüsü (kopya döner — çağıran mutasyonu etkilemez). */
export function getMcpStats(): McpStatsSnapshot {
  const snapshot: Record<string, McpToolStat> = {};
  for (const [k, v] of byTool) snapshot[k] = { ...v };
  return { totalCalls, totalErrors, byTool: snapshot };
}

/** Sayaçları sıfırlar (test / yeniden başlatma). */
export function resetMcpStats(): void {
  byTool.clear();
  totalCalls = 0;
  totalErrors = 0;
}
