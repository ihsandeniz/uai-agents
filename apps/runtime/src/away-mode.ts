import type { AwayModePolicy, Task, AgentName } from '@uai/shared';
import { CoreAgent } from './agents/core.js';
import type { TaskQueue } from './queue.js';
import { db } from './db.js';
import { tasks as tasksTable } from '@uai/db/schema';
import { publishEvent } from './events.js';
import { classifyAction } from './approval/service.js';
import { learning } from './learning.js';
import { logger } from './logger.js';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';

const DEFAULT_POLICY: AwayModePolicy = {
  allowedActionClasses: ['GREEN', 'YELLOW'],
  costCeilingUsdPerHour: 0.50,
  loopDetectionThreshold: 3,
  maxRefinementIterations: 2,
  reportIntervalMinutes: 15,
};

interface AwayModeState {
  active: boolean;
  policy: AwayModePolicy;
  startedAt: Date | null;
  totalCost: number;
  tasksCompleted: number;
  recentGoals: string[];  // For loop detection
  core: CoreAgent | null;
  queue: TaskQueue | null;
  intervalId: ReturnType<typeof setInterval> | null;
}

const state: AwayModeState = {
  active: false,
  policy: DEFAULT_POLICY,
  startedAt: null,
  totalCost: 0,
  tasksCompleted: 0,
  recentGoals: [],
  core: null,
  queue: null,
  intervalId: null,
};

export function isAwayModeActive(): boolean {
  return state.active;
}

export function getAwayModeStatus() {
  if (!state.active) return { active: false };
  const elapsed = state.startedAt ? (Date.now() - state.startedAt.getTime()) / 1000 / 60 : 0;
  return {
    active: true,
    elapsedMinutes: Math.round(elapsed),
    totalCost: state.totalCost,
    tasksCompleted: state.tasksCompleted,
    costCeiling: state.policy.costCeilingUsdPerHour,
  };
}

/** Start away mode with a queue of tasks.
 *  Pass `queue` to reuse its CoreAgent so agent statuses stay in sync. */
export async function startAwayMode(
  taskGoals: string[],
  policy?: Partial<AwayModePolicy>,
  queue?: TaskQueue,
): Promise<void> {
  if (state.active) {
    logger.warn('Away mode already active');
    return;
  }

  state.active = true;
  state.policy = { ...DEFAULT_POLICY, ...policy };
  state.startedAt = new Date();
  state.totalCost = 0;
  state.tasksCompleted = 0;
  state.recentGoals = [];
  state.queue = queue ?? null;
  // B4: reuse TaskQueue's CoreAgent if available, so agent statuses stay in sync
  state.core = queue ? queue.getCoreAgent() : new CoreAgent();

  await publishEvent({
    type: 'agent_status',
    data: { mode: 'away', taskCount: taskGoals.length },
  });

  // Periodic status report (uses reportIntervalMinutes from policy)
  state.intervalId = setInterval(async () => {
    const status = getAwayModeStatus();
    await publishEvent({ type: 'agent_status', data: { mode: 'away', ...status } }).catch(() => {});
    logger.info(status, 'away mode periodic report');
  }, state.policy.reportIntervalMinutes * 60_000);

  logger.info({ taskCount: taskGoals.length, policy: state.policy }, 'away mode started');

  // Process tasks sequentially
  for (const goal of taskGoals) {
    if (!state.active) break;

    // Cost ceiling check
    const elapsedHours = (Date.now() - state.startedAt!.getTime()) / 1000 / 3600;
    const costRate = elapsedHours > 0 ? state.totalCost / elapsedHours : 0;
    if (costRate > state.policy.costCeilingUsdPerHour) {
      logger.warn({ costRate, ceiling: state.policy.costCeilingUsdPerHour }, 'cost ceiling reached — pausing');
      await publishEvent({ type: 'approval_needed', data: { reason: 'cost_ceiling', costRate } });
      break;
    }

    // Loop detection
    if (detectLoop(goal)) {
      logger.warn({ goal }, 'loop detected — skipping');
      await publishEvent({ type: 'approval_needed', data: { reason: 'loop_detected', goal } });
      continue;
    }

    // Action class check
    const actionClass = classifyAction(goal);
    if (!state.policy.allowedActionClasses.includes(actionClass as 'GREEN' | 'YELLOW')) {
      logger.info({ goal, actionClass }, 'action class not allowed in away mode — skipping');
      await publishEvent({ type: 'approval_needed', data: { reason: 'action_class', goal, actionClass } });
      continue;
    }

    // Execute task
    try {
      const taskId = ulid();
      const now = new Date();
      const task: Task = {
        id: taskId,
        projectId: 'default',
        goal,
        acceptanceCriteria: ['Görevi doğru tamamla'],
        assignedTo: 'core',
        status: 'in_progress',
        priority: 2,
        dependencies: [],
        createdAt: now,
        startedAt: now,
        refineCount: 0,
      };

      // B2: persist task to DB before execution
      await db.insert(tasksTable).values({
        id: task.id,
        projectId: task.projectId,
        goal: task.goal,
        acceptanceCriteria: task.acceptanceCriteria,
        assignedTo: task.assignedTo,
        status: task.status,
        priority: task.priority,
        dependencies: task.dependencies,
        refineCount: task.refineCount,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
      });

      await publishEvent({ type: 'task_started', data: { taskId, goal } });

      const result = await state.core!.execute(task);
      state.totalCost += result.costUsd;
      state.tasksCompleted++;
      state.recentGoals.push(goal);

      // B2: update task status in DB
      await db.update(tasksTable).set({
        status: 'done',
        completedAt: new Date(),
        result,
      }).where(eq(tasksTable.id, taskId));

      // B5: record to learning system — skip complex DAG tasks to avoid bad routing data
      const agentMatch = result.reasoning?.match(/\[Core → (\w+)\]/);
      if (agentMatch?.[1]) {
        learning.record({
          goal,
          assignedTo: agentMatch[1] as AgentName,
          confidence: result.confidence,
          costUsd: result.costUsd,
          durationMs: Date.now() - now.getTime(),
          success: result.confidence >= 0.5,
        });
      }

      await publishEvent({
        type: 'task_completed',
        data: { taskId, goal, confidence: result.confidence, cost: result.costUsd },
      });

      logger.info({ taskId, confidence: result.confidence, cost: result.costUsd }, 'away mode task completed');
    } catch (err) {
      logger.error({ err, goal }, 'away mode task failed');
    }
  }

  await stopAwayMode();
}

function detectLoop(goal: string): boolean {
  const threshold = state.policy.loopDetectionThreshold;
  const recent = state.recentGoals.slice(-threshold);
  if (recent.length < threshold) return false;

  // Simple similarity: if the last N goals are very similar, it's a loop
  const lowerGoal = goal.toLowerCase();
  const similarCount = recent.filter((g) => {
    const lower = g.toLowerCase();
    // Check if >60% of words overlap
    const words1 = new Set(lowerGoal.split(/\s+/));
    const words2 = new Set(lower.split(/\s+/));
    const overlap = [...words1].filter((w) => words2.has(w)).length;
    return overlap / Math.max(words1.size, words2.size) > 0.6;
  }).length;

  return similarCount >= threshold - 1;
}

export async function stopAwayMode(): Promise<void> {
  if (!state.active) return;

  state.active = false;

  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }

  const summary = {
    tasksCompleted: state.tasksCompleted,
    totalCost: state.totalCost,
    elapsedMinutes: state.startedAt
      ? Math.round((Date.now() - state.startedAt.getTime()) / 1000 / 60)
      : 0,
  };

  await publishEvent({ type: 'agent_status', data: { mode: 'interactive', ...summary } });
  logger.info(summary, 'away mode stopped');

  state.core = null;
  state.queue = null;
  state.startedAt = null;
}
