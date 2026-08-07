import type { AgentName } from '@uai/shared';
import { logger } from './logger.js';
import { db } from './db.js';
import { routingRecords } from '@uai/db/schema';
import { desc } from 'drizzle-orm';
import { ulid } from 'ulid';

const DAY_MS = 86_400_000;

export interface RoutingRecord {
  goal: string;
  assignedTo: AgentName;
  confidence: number;
  costUsd: number;
  durationMs: number;
  success: boolean;
  /** Kaydın oluştuğu an. Verilmezse "şimdi" kabul edilir (çağıran kod değişmez). */
  recordedAt?: Date;
}

/** Buffer'da tutulan hâli — zaman damgası burada zorunlu. */
interface StoredRecord extends RoutingRecord {
  recordedAt: Date;
}

export interface AgentPerformance {
  tasks: number;
  effectiveTasks: number;
  successRate: number;
  avgConfidence: number;
  avgCost: number;
  avgDurationMs: number;
  topCategories: string[];
}

export interface LearningOptions {
  /** Bir kaydın ağırlığının yarıya düşmesi için geçmesi gereken gün. <= 0 → decay kapalı. */
  halfLifeDays?: number;
  /** Bu ağırlığın altına düşen kayıt tamamen atılır. */
  minWeight?: number;
  maxRecords?: number;
  /** Test edilebilirlik için saat kaynağı. */
  now?: () => number;
}

/**
 * Bir kaydın yaşına göre ağırlığı: w = 2^(-Δt / halfLife).
 * Yaş 0 → 1, bir yarı ömür → 0.5, iki yarı ömür → 0.25.
 * halfLifeDays <= 0 (veya sonsuz) → decay kapalı, herkes 1 ağırlıkta (eski davranış).
 */
export function decayWeight(ageMs: number, halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1;
  if (ageMs <= 0) return 1; // saat kayması / gelecek tarihli kayıt 1'i aşmasın
  return Math.pow(2, -(ageMs / (halfLifeDays * DAY_MS)));
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn({ env: name, value: raw, fallback }, 'invalid learning config value — using default');
    return fallback;
  }
  return parsed;
}

/**
 * LearningSystem — ajan performansını izler ve yönlendirmeyi zamanla iyileştirir.
 * Bellekte tutulur, `routing_records` tablosundan beslenir.
 *
 * Decay: her kaydın ağırlığı yaşıyla üstel olarak azalır (`decayWeight`). Böylece
 * 3 ay önce bir kez doğru çıkmış bir yönlendirme, dün 10 kez yanlış çıkmış olanı
 * gölgeleyemez. Ağırlığı `minWeight`in altına düşen kayıt buffer'dan atılır.
 */
export class LearningSystem {
  private records: StoredRecord[] = [];
  private readonly maxRecords: number;
  private readonly halfLifeDays: number;
  private readonly minWeight: number;
  private readonly now: () => number;
  /** suggestAgent eşiği — decay öncesinden devralındı, davranış korunuyor. */
  private readonly suggestThreshold = 1;

  constructor(opts: LearningOptions = {}) {
    this.maxRecords = opts.maxRecords ?? 500;
    // Varsayılan 30 gün: UAI'de ajan prompt'ları/model seçimi haftalar içinde
    // değişiyor; bir ay boyunca yeniden doğrulanmamış yönlendirme kanıtı yarı
    // ağırlığa düşsün. Ölçümle türetilmiş değil, tartışılabilir başlangıç değeri —
    // LEARNING_HALF_LIFE_DAYS ile değiştirilebilir, 0 vermek decay'i kapatır.
    this.halfLifeDays = opts.halfLifeDays ?? envNumber('LEARNING_HALF_LIFE_DAYS', 30);
    // %1 ağırlık ≈ 6.6 yarı ömür; varsayılanda ~200 günlük hafıza ufku.
    this.minWeight = opts.minWeight ?? envNumber('LEARNING_MIN_WEIGHT', 0.01);
    this.now = opts.now ?? Date.now;
  }

  /** Load historical records from DB on startup */
  async loadFromDb(): Promise<void> {
    try {
      const rows = await db.select().from(routingRecords).orderBy(desc(routingRecords.createdAt)).limit(this.maxRecords);
      const now = this.now();
      let undated = 0;
      for (const row of rows.reverse()) {
        // created_at şemada zaten var (defaultNow) — decay için migration gerekmiyor.
        // Yine de NULL gelirse satırı düşürmüyoruz: "şimdi" sayıp okunur tutuyoruz.
        if (!row.createdAt) undated++;
        this.records.push({
          goal: row.goal,
          assignedTo: row.assignedTo as AgentName,
          confidence: row.confidence,
          costUsd: row.costUsd,
          durationMs: row.durationMs,
          success: row.success === 1,
          recordedAt: row.createdAt ?? new Date(now),
        });
      }
      const before = this.records.length;
      this.prune(now);
      logger.info(
        { loaded: rows.length, kept: this.records.length, expired: before - this.records.length, undated, halfLifeDays: this.halfLifeDays },
        'learning records loaded from DB',
      );
    } catch (err) {
      logger.warn({ err }, 'failed to load learning records from DB — starting fresh');
    }
  }

  /** Record a completed task for learning */
  record(entry: RoutingRecord): void {
    const now = this.now();
    const stored: StoredRecord = { ...entry, recordedAt: entry.recordedAt ?? new Date(now) };
    this.records.push(stored);
    this.prune(now);

    // Persist to DB (fire and forget) — created_at DB tarafında defaultNow()
    db.insert(routingRecords).values({
      id: ulid(),
      goal: stored.goal,
      assignedTo: stored.assignedTo,
      confidence: stored.confidence,
      costUsd: stored.costUsd,
      durationMs: stored.durationMs,
      success: stored.success ? 1 : 0,
      createdAt: stored.recordedAt,
    }).catch((err) => logger.warn({ err }, 'failed to persist routing record'));

    logger.debug({ agent: stored.assignedTo, success: stored.success, confidence: stored.confidence }, 'learning record added');
  }

  /** Ağırlığı sıfıra yaklaşmış kayıtları at, sonra buffer tavanını uygula. */
  private prune(now: number): void {
    if (this.halfLifeDays > 0 && Number.isFinite(this.halfLifeDays)) {
      this.records = this.records.filter((r) => this.weightOf(r, now) >= this.minWeight);
    }
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  private weightOf(record: StoredRecord, now: number): number {
    return decayWeight(now - record.recordedAt.getTime(), this.halfLifeDays);
  }

  /**
   * Get performance summary for all agents.
   * Ortalamalar zaman-ağırlıklı: eski kayıtlar oranı daha az çeker.
   */
  getSummary(): Record<string, AgentPerformance> {
    const now = this.now();
    const acc = new Map<AgentName, {
      tasks: number; weight: number; success: number; confidence: number; cost: number; duration: number;
      categories: Map<string, number>;
    }>();

    for (const record of this.records) {
      const w = this.weightOf(record, now);
      if (w < this.minWeight) continue;

      let a = acc.get(record.assignedTo);
      if (!a) {
        a = { tasks: 0, weight: 0, success: 0, confidence: 0, cost: 0, duration: 0, categories: new Map() };
        acc.set(record.assignedTo, a);
      }
      a.tasks++;
      a.weight += w;
      if (record.success) a.success += w;
      a.confidence += w * record.confidence;
      a.cost += w * record.costUsd;
      a.duration += w * record.durationMs;

      const keywords = record.goal.toLowerCase().split(/\s+/).filter((word) => word.length > 3);
      for (const kw of keywords.slice(0, 5)) {
        a.categories.set(kw, (a.categories.get(kw) ?? 0) + w);
      }
    }

    const result: Record<string, AgentPerformance> = {};
    for (const [name, a] of acc) {
      const w = a.weight || 1; // koruma: bölme sıfıra düşmesin
      result[name] = {
        tasks: a.tasks,
        effectiveTasks: Math.round(a.weight * 100) / 100,
        successRate: Math.round((a.success / w) * 100) / 100,
        avgConfidence: Math.round((a.confidence / w) * 100) / 100,
        avgCost: Math.round((a.cost / w) * 10000) / 10000,
        avgDurationMs: Math.round(a.duration / w),
        topCategories: [...a.categories.entries()]
          .sort((x, y) => y[1] - x[1])
          .slice(0, 5)
          .map(([k]) => k),
      };
    }
    return result;
  }

  /**
   * Suggest best agent for a goal based on past performance.
   * Skor = kelime örtüşmesi × confidence × zaman ağırlığı.
   * Yalnızca bayat kanıt kaldıysa skor eşiğin altına düşer → null → LLM yönlendirmesi devreye girer.
   */
  suggestAgent(goal: string): AgentName | null {
    const now = this.now();
    const active = this.records.filter((r) => this.weightOf(r, now) >= this.minWeight);
    if (active.length < 5) return null; // Not enough data

    const keywords = goal.toLowerCase().split(/\s+/).filter((word) => word.length > 3);
    const scores = new Map<AgentName, number>();

    for (const record of active) {
      if (!record.success) continue;
      const recordWords = record.goal.toLowerCase().split(/\s+/);
      const overlap = keywords.filter((kw) => recordWords.some((rw) => rw.includes(kw) || kw.includes(rw))).length;
      if (overlap > 0) {
        const current = scores.get(record.assignedTo) ?? 0;
        scores.set(record.assignedTo, current + overlap * record.confidence * this.weightOf(record, now));
      }
    }

    if (scores.size === 0) return null;

    const best = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
    return best[1] > this.suggestThreshold ? best[0] : null; // threshold
  }
}

export const learning = new LearningSystem();
