import type { TaskQueue } from './queue.js';

/**
 * Minimal Prometheus text-format metrics registry.
 * No external library — counters and gauges tracked in-process.
 * Expose via GET /metrics.
 */

interface Counter {
  type: 'counter';
  help: string;
  values: Map<string, number>;
}

interface Gauge {
  type: 'gauge';
  help: string;
  values: Map<string, number>;
}

interface Histogram {
  type: 'histogram';
  help: string;
  buckets: number[]; // upper bounds in ms
  counts: number[];  // count per bucket
  sum: number;
  count: number;
}

const registry = new Map<string, Counter | Gauge | Histogram>();

function getOrCreateCounter(name: string, help: string): Counter {
  if (!registry.has(name)) registry.set(name, { type: 'counter', help, values: new Map() });
  return registry.get(name) as Counter;
}

function getOrCreateHistogram(name: string, help: string, buckets: number[]): Histogram {
  if (!registry.has(name)) {
    registry.set(name, { type: 'histogram', help, buckets, counts: buckets.map(() => 0), sum: 0, count: 0 });
  }
  return registry.get(name) as Histogram;
}

// ── Public recording functions ─────────────────────────────────────────────

export function recordTaskCompleted(costUsd: number, durationMs: number): void {
  const c = getOrCreateCounter('uai_tasks_total', 'Total tasks processed by status');
  c.values.set('status="completed"', (c.values.get('status="completed"') ?? 0) + 1);

  const cost = getOrCreateCounter('uai_cost_usd_total', 'Total LLM cost in USD');
  cost.values.set('', (cost.values.get('') ?? 0) + costUsd);

  const h = getOrCreateHistogram(
    'uai_task_duration_ms',
    'Task execution duration in milliseconds',
    [500, 1000, 2000, 5000, 10000, 30000],
  );
  for (let i = 0; i < h.buckets.length; i++) {
    if (durationMs <= h.buckets[i]) h.counts[i]++;
  }
  h.sum += durationMs;
  h.count++;
}

export function recordTaskFailed(): void {
  const c = getOrCreateCounter('uai_tasks_total', 'Total tasks processed by status');
  c.values.set('status="failed"', (c.values.get('status="failed"') ?? 0) + 1);
}

export function recordHttpRequest(method: string, path: string, status: number): void {
  const c = getOrCreateCounter('uai_http_requests_total', 'Total HTTP requests');
  const label = `method="${method}",path="${path}",status="${status}"`;
  c.values.set(label, (c.values.get(label) ?? 0) + 1);
}

// ── Renderer ──────────────────────────────────────────────────────────────

function escapeHelp(s: string): string {
  return s.replace(/\n/g, '\\n');
}

/**
 * Renders all registered metrics plus live queue gauges in Prometheus text format.
 */
export function renderMetrics(queue?: TaskQueue): string {
  const lines: string[] = [];

  // Live queue gauges (pulled on demand)
  if (queue) {
    const stats = queue.getStats();
    lines.push('# HELP uai_queue_pending Number of tasks waiting in queue');
    lines.push('# TYPE uai_queue_pending gauge');
    lines.push(`uai_queue_pending ${stats.pending}`);
    lines.push('# HELP uai_queue_running Number of tasks currently running');
    lines.push('# TYPE uai_queue_running gauge');
    lines.push(`uai_queue_running ${stats.running}`);
    lines.push('# HELP uai_queue_paused 1 if queue is paused');
    lines.push('# TYPE uai_queue_paused gauge');
    lines.push(`uai_queue_paused ${stats.paused ? 1 : 0}`);
    lines.push('# HELP uai_total_cost_usd Total accumulated LLM cost tracked by queue');
    lines.push('# TYPE uai_total_cost_usd gauge');
    lines.push(`uai_total_cost_usd ${stats.totalCost.toFixed(6)}`);
  }

  for (const [name, metric] of registry) {
    lines.push(`# HELP ${name} ${escapeHelp(metric.help)}`);
    lines.push(`# TYPE ${name} ${metric.type}`);

    if (metric.type === 'counter' || metric.type === 'gauge') {
      for (const [label, value] of metric.values) {
        lines.push(label ? `${name}{${label}} ${value}` : `${name} ${value}`);
      }
    } else if (metric.type === 'histogram') {
      let cumulative = 0;
      for (let i = 0; i < metric.buckets.length; i++) {
        cumulative += metric.counts[i];
        lines.push(`${name}_bucket{le="${metric.buckets[i]}"} ${cumulative}`);
      }
      lines.push(`${name}_bucket{le="+Inf"} ${metric.count}`);
      lines.push(`${name}_sum ${metric.sum}`);
      lines.push(`${name}_count ${metric.count}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
