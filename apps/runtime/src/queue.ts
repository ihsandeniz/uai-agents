import type { Task, TaskResult } from '@uai/shared';
import { logger } from './logger.js';
import { publishEvent } from './events.js';
import { db } from './db.js';
import { tasks as tasksTable } from '@uai/db/schema';
import { eq } from 'drizzle-orm';
import { saveMemory } from './memory/service.js';
import { CoreAgent } from './agents/core.js';
import { learning } from './learning.js';
import { requestApproval, classifyAction } from './approval/service.js';
import { dispatchWebhooks } from './webhooks/service.js';
import { recordTaskCompleted, recordTaskFailed } from './metrics.js';

interface QueueItem {
  task: Task;
  addedAt: number;
}

export interface QueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  avgDurationMs: number;
}

/**
 * TaskQueue — concurrent task execution with priority ordering.
 * - Max N tasks run in parallel (default 3)
 * - Higher priority (lower number) runs first
 * - Tracks stats for monitoring
 */
export class TaskQueue {
  private pending: QueueItem[] = [];
  private running = new Map<string, { task: Task; startedAt: number }>();
  private core: CoreAgent;
  private maxConcurrency: number;
  private stats = { completed: 0, failed: 0, totalDurationMs: 0 };
  private _paused = false;
  private _totalCost = 0;
  private _costAlertThreshold = 1.0; // USD — alert when exceeded
  private _costAlertFired = false;   // fire only once per threshold crossing

  constructor(opts?: { maxConcurrency?: number; costAlertThreshold?: number }) {
    this.maxConcurrency = opts?.maxConcurrency ?? 3;
    this._costAlertThreshold = opts?.costAlertThreshold ?? 1.0;
    this.core = new CoreAgent();
  }

  get paused(): boolean { return this._paused; }
  get totalCost(): number { return this._totalCost; }

  /** Add task to queue */
  enqueue(task: Task): void {
    this.pending.push({ task, addedAt: Date.now() });
    // Sort by priority (lower = higher priority)
    this.pending.sort((a, b) => a.task.priority - b.task.priority);
    logger.info({ taskId: task.id, pending: this.pending.length, running: this.running.size }, 'task queued');
    this.drain();
  }

  /** Pause the queue — running tasks finish, no new ones start */
  pause(): void {
    this._paused = true;
    logger.info('queue paused');
    publishEvent({ type: 'queue_paused', data: { pending: this.pending.length, running: this.running.size } });
  }

  /** Resume the queue */
  resume(): void {
    this._paused = false;
    logger.info('queue resumed');
    publishEvent({ type: 'queue_resumed', data: {} });
    this.drain();
  }

  /** Retry a failed task by ID */
  async retry(taskId: string): Promise<boolean> {
    const rows = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (rows.length === 0 || rows[0].status !== 'failed') return false;

    const row = rows[0];
    const task: Task = {
      id: taskId,
      projectId: row.projectId ?? 'default',
      goal: row.goal ?? '',
      acceptanceCriteria: (row.acceptanceCriteria as string[]) ?? ['Görevi doğru tamamla'],
      assignedTo: 'core',
      status: 'in_progress',
      priority: (row.priority ?? 2) as 1 | 2 | 3,
      dependencies: (row.dependencies as string[]) ?? [],
      createdAt: row.createdAt ?? new Date(),
      startedAt: new Date(),
      refineCount: (row.refineCount ?? 0) + 1,
    };

    await db.update(tasksTable).set({ status: 'in_progress', startedAt: task.startedAt }).where(eq(tasksTable.id, taskId));
    await publishEvent({ type: 'task_started', data: { taskId, goal: task.goal, retry: true } });

    this.enqueue(task);
    return true;
  }

  /** Try to start next tasks if capacity available */
  private drain(): void {
    if (this._paused) return;
    while (this.running.size < this.maxConcurrency && this.pending.length > 0) {
      const item = this.pending.shift()!;
      this.startTask(item.task);
    }
  }

  /** Execute a single task */
  private startTask(task: Task): void {
    const startedAt = Date.now();
    this.running.set(task.id, { task, startedAt });

    logger.info({ taskId: task.id, goal: task.goal.slice(0, 60), running: this.running.size }, 'task starting');

    this.core.execute(task).then(async (result) => {
      const durationMs = Date.now() - startedAt;
      this.running.delete(task.id);
      this.stats.completed++;
      this.stats.totalDurationMs += durationMs;
      this._totalCost += result.costUsd;

      // Cost alert check — fire only once when threshold is first crossed
      if (!this._costAlertFired && this._totalCost >= this._costAlertThreshold) {
        this._costAlertFired = true;
        await publishEvent({ type: 'cost_alert', data: { totalCost: this._totalCost, threshold: this._costAlertThreshold } });
        logger.warn({ totalCost: this._totalCost, threshold: this._costAlertThreshold }, 'cost alert threshold exceeded');
      }

      // Save result to DB
      await db.update(tasksTable).set({
        status: 'done',
        completedAt: new Date(),
        result,
      }).where(eq(tasksTable.id, task.id));

      await publishEvent({
        type: 'task_completed',
        data: {
          taskId: task.id,
          goal: task.goal,
          confidence: result.confidence,
          cost: result.costUsd,
          durationMs,
          output: typeof result.output === 'string' ? result.output.slice(0, 500) : undefined,
        },
      });

      // Save to episodic memory — fire-and-forget, never fails the task
      saveMemory({
        layer: 'episodic',
        content: `Görev: ${task.goal}\nSonuç: ${typeof result.output === 'string' ? result.output.slice(0, 1000) : JSON.stringify(result.output).slice(0, 1000)}`,
        agent: 'core',
        sourceTaskId: task.id,
        confidence: result.confidence,
        tags: ['task-result'],
      }).catch((err) => logger.warn({ err }, 'saveMemory failed (non-fatal)'));

      // Record for learning — only when agent is unambiguous (skip complex DAG tasks
      // whose reasoning starts with "[Core DAG:" to avoid poisoning routing data)
      const agentMatch = result.reasoning?.match(/\[Core → (\w+)\]/);
      if (agentMatch?.[1]) {
        learning.record({
          goal: task.goal,
          assignedTo: agentMatch[1] as import('@uai/shared').AgentName,
          confidence: result.confidence,
          costUsd: result.costUsd,
          durationMs,
          success: result.confidence >= 0.5,
        });
      }

      recordTaskCompleted(result.costUsd, durationMs);
      logger.info({ taskId: task.id, durationMs, confidence: result.confidence, cost: result.costUsd }, 'task completed');

      // Webhook dispatch — fire-and-forget
      dispatchWebhooks('task_completed', {
        taskId: task.id,
        projectId: task.projectId,
        goal: task.goal,
        confidence: result.confidence,
        costUsd: result.costUsd,
        durationMs,
      }).catch(() => {});

      // Drain next
      this.drain();
    }).catch(async (err) => {
      this.running.delete(task.id);
      this.stats.failed++;

      recordTaskFailed();
      logger.error({ err, taskId: task.id }, 'task execution failed');
      await db.update(tasksTable).set({ status: 'failed' }).where(eq(tasksTable.id, task.id)).catch(() => {});
      const actionClass = classifyAction(task.goal);
      await requestApproval(task.id, actionClass, task.goal, 'core').catch(() => {});
      await publishEvent({ type: 'approval_needed', data: { taskId: task.id, reason: 'error', error: String(err) } });

      // Webhook dispatch — fire-and-forget
      dispatchWebhooks('task_failed', {
        taskId: task.id,
        projectId: task.projectId,
        goal: task.goal,
        error: String(err),
      }).catch(() => {});

      this.drain();
    });
  }

  /** Get queue statistics */
  getStats(): QueueStats & { paused: boolean; totalCost: number } {
    return {
      pending: this.pending.length,
      running: this.running.size,
      completed: this.stats.completed,
      failed: this.stats.failed,
      avgDurationMs: this.stats.completed > 0 ? Math.round(this.stats.totalDurationMs / this.stats.completed) : 0,
      paused: this._paused,
      totalCost: this._totalCost,
    };
  }

  /** Expose the CoreAgent instance (for shared use, e.g. away-mode) */
  getCoreAgent(): CoreAgent {
    return this.core;
  }

  /** Get agent statuses from core */
  getAgentStatuses() {
    return this.core.getAgentStatuses();
  }
}
