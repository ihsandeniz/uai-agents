import type { AgentName } from '@uai/shared';
import { logger } from './logger.js';
import { db } from './db.js';
import { routingRecords } from '@uai/db/schema';
import { desc } from 'drizzle-orm';
import { ulid } from 'ulid';

interface RoutingRecord {
  goal: string;
  assignedTo: AgentName;
  confidence: number;
  costUsd: number;
  durationMs: number;
  success: boolean;
}

interface AgentPerformance {
  totalTasks: number;
  successRate: number;
  avgConfidence: number;
  avgCost: number;
  avgDurationMs: number;
  categories: Map<string, number>; // keyword → count
}

/**
 * LearningSystem — tracks agent performance and improves routing over time.
 * In-memory for now, could persist to DB later.
 */
class LearningSystem {
  private records: RoutingRecord[] = [];
  private agentStats = new Map<AgentName, AgentPerformance>();
  private maxRecords = 500;

  /** Load historical records from DB on startup */
  async loadFromDb(): Promise<void> {
    try {
      const rows = await db.select().from(routingRecords).orderBy(desc(routingRecords.createdAt)).limit(this.maxRecords);
      for (const row of rows.reverse()) {
        const entry: RoutingRecord = {
          goal: row.goal,
          assignedTo: row.assignedTo as AgentName,
          confidence: row.confidence,
          costUsd: row.costUsd,
          durationMs: row.durationMs,
          success: row.success === 1,
        };
        this.records.push(entry);
        this.updateStats(entry);
      }
      logger.info({ loaded: rows.length }, 'learning records loaded from DB');
    } catch (err) {
      logger.warn({ err }, 'failed to load learning records from DB — starting fresh');
    }
  }

  /** Record a completed task for learning */
  record(entry: RoutingRecord): void {
    this.records.push(entry);
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }

    // Persist to DB (fire and forget)
    db.insert(routingRecords).values({
      id: ulid(),
      goal: entry.goal,
      assignedTo: entry.assignedTo,
      confidence: entry.confidence,
      costUsd: entry.costUsd,
      durationMs: entry.durationMs,
      success: entry.success ? 1 : 0,
    }).catch((err) => logger.warn({ err }, 'failed to persist routing record'));

    this.updateStats(entry);
    logger.debug({ agent: entry.assignedTo, success: entry.success, confidence: entry.confidence }, 'learning record added');
  }

  private updateStats(entry: RoutingRecord): void {
    const stats = this.getOrCreateStats(entry.assignedTo);
    stats.totalTasks++;
    if (entry.success) {
      stats.successRate = (stats.successRate * (stats.totalTasks - 1) + 1) / stats.totalTasks;
    } else {
      stats.successRate = (stats.successRate * (stats.totalTasks - 1)) / stats.totalTasks;
    }
    stats.avgConfidence = (stats.avgConfidence * (stats.totalTasks - 1) + entry.confidence) / stats.totalTasks;
    stats.avgCost = (stats.avgCost * (stats.totalTasks - 1) + entry.costUsd) / stats.totalTasks;
    stats.avgDurationMs = (stats.avgDurationMs * (stats.totalTasks - 1) + entry.durationMs) / stats.totalTasks;

    const keywords = entry.goal.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    for (const kw of keywords.slice(0, 5)) {
      stats.categories.set(kw, (stats.categories.get(kw) ?? 0) + 1);
    }
  }

  /** Get performance summary for all agents */
  getSummary(): Record<string, { tasks: number; successRate: number; avgConfidence: number; avgCost: number; topCategories: string[] }> {
    const result: Record<string, { tasks: number; successRate: number; avgConfidence: number; avgCost: number; topCategories: string[] }> = {};

    for (const [name, stats] of this.agentStats) {
      const topCats = [...stats.categories.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k]) => k);

      result[name] = {
        tasks: stats.totalTasks,
        successRate: Math.round(stats.successRate * 100) / 100,
        avgConfidence: Math.round(stats.avgConfidence * 100) / 100,
        avgCost: Math.round(stats.avgCost * 10000) / 10000,
        topCategories: topCats,
      };
    }
    return result;
  }

  /** Suggest best agent for a goal based on past performance */
  suggestAgent(goal: string): AgentName | null {
    if (this.records.length < 5) return null; // Not enough data

    const keywords = goal.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const scores = new Map<AgentName, number>();

    for (const record of this.records) {
      if (!record.success) continue;
      const recordWords = record.goal.toLowerCase().split(/\s+/);
      const overlap = keywords.filter(kw => recordWords.some(rw => rw.includes(kw) || kw.includes(rw))).length;
      if (overlap > 0) {
        const current = scores.get(record.assignedTo) ?? 0;
        scores.set(record.assignedTo, current + overlap * record.confidence);
      }
    }

    if (scores.size === 0) return null;

    const best = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
    return best[1] > 1 ? best[0] : null; // threshold
  }

  private getOrCreateStats(agent: AgentName): AgentPerformance {
    let stats = this.agentStats.get(agent);
    if (!stats) {
      stats = { totalTasks: 0, successRate: 0, avgConfidence: 0, avgCost: 0, avgDurationMs: 0, categories: new Map() };
      this.agentStats.set(agent, stats);
    }
    return stats;
  }
}

export const learning = new LearningSystem();
