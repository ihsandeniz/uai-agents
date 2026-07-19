import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { logger } from './logger.js';
import { db, pingDb } from './db.js';
import { pingRedis, redis } from './redis.js';
import { handleSSE, initEventStream, publishEvent } from './events.js';
import { TaskQueue } from './queue.js';
import { startAwayMode, stopAwayMode, getAwayModeStatus } from './away-mode.js';
import { recallMemory } from './memory/service.js';
import { getPendingApprovals, resolveApproval } from './approval/service.js';
import { learning } from './learning.js';
import { tasks as tasksTable } from '@uai/db/schema';
import { ensureDefaultProject, createProject, listProjects, getProject, updateProjectStatus } from './projects/service.js';
import { registerWebhook, listWebhooks, deleteWebhook } from './webhooks/service.js';
import { checkAuth } from './middleware/auth.js';
import { checkRateLimit, checkStrictRateLimit } from './middleware/ratelimit.js';
import { renderMetrics, recordHttpRequest } from './metrics.js';
import { initMcp, shutdownMcp } from './mcp/index.js';
import { desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Task, AwayModePolicy } from '@uai/shared';

const PORT = parseInt(process.env.PORT || '3000', 10);

const queue = new TaskQueue({ maxConcurrency: 3 });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function addSecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
}

function json(res: ServerResponse, status: number, data: unknown) {
  addSecurityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // CORS headers — restrict to known origins
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3001,http://localhost:3000')
    .split(',').map(o => o.trim());
  const origin = req.headers.origin ?? '';
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');

  if (req.method === 'OPTIONS') {
    addSecurityHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Prometheus metrics — no auth, no rate limit (scraper access)
  if (url.pathname === '/metrics' && req.method === 'GET') {
    addSecurityHeaders(res);
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(renderMetrics(queue));
    return;
  }

  // Rate limiting
  if (!await checkRateLimit(req)) {
    json(res, 429, { error: 'too many requests' });
    return;
  }

  // Auth
  if (!checkAuth(req, url)) {
    json(res, 401, { error: 'unauthorized — provide X-Api-Key header or ?key= param' });
    return;
  }

  // Track HTTP request metric (best-effort, status captured at response end)
  const _trackMetric = (status: number) =>
    recordHttpRequest(req.method ?? 'GET', url.pathname, status);

  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    const [dbOk, redisOk] = await Promise.all([pingDb(), pingRedis()]);
    const status = dbOk && redisOk ? 200 : 503;
    const body = {
      status: status === 200 ? 'ok' : 'degraded',
      db: dbOk,
      redis: redisOk,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
    addSecurityHeaders(res);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  // SSE stream
  if (url.pathname === '/api/stream' && req.method === 'GET') {
    handleSSE(req, res);
    return;
  }

  // API: Get agent statuses
  if (url.pathname === '/api/agents' && req.method === 'GET') {
    json(res, 200, queue.getAgentStatuses());
    return;
  }

  // API: Queue stats
  if (url.pathname === '/api/queue' && req.method === 'GET') {
    json(res, 200, queue.getStats());
    return;
  }

  // API: Get system status
  if (url.pathname === '/api/status' && req.method === 'GET') {
    json(res, 200, {
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      awayMode: getAwayModeStatus(),
    });
    return;
  }

  // API: Submit a task
  if (url.pathname === '/api/task' && req.method === 'POST') {
    if (!await checkStrictRateLimit(req)) {
      json(res, 429, { error: 'rate limit exceeded for task submission (20/min)' });
      return;
    }
    try {
      const body = JSON.parse(await readBody(req));
      const goal = body.goal as string;
      if (!goal?.trim()) {
        json(res, 400, { error: 'goal is required' });
        return;
      }

      const taskId = ulid();
      const task: Task = {
        id: taskId,
        projectId: body.projectId ?? 'default',
        goal,
        acceptanceCriteria: body.criteria ?? ['Görevi doğru tamamla'],
        assignedTo: 'core',
        status: 'in_progress',
        priority: body.priority ?? 2,
        dependencies: [],
        createdAt: new Date(),
        startedAt: new Date(),
        refineCount: 0,
      };

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

      // Enqueue — returns immediately, executes in background
      queue.enqueue(task);
      json(res, 202, { taskId, status: 'queued', queueStats: queue.getStats() });
    } catch (err) {
      json(res, 400, { error: 'invalid JSON body' });
    }
    return;
  }

  // API: Task history
  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const rows = await db.select().from(tasksTable).orderBy(desc(tasksTable.createdAt)).limit(limit);
    json(res, 200, rows);
    return;
  }

  // API: Single task detail
  if (url.pathname.startsWith('/api/tasks/') && req.method === 'GET') {
    const taskId = url.pathname.split('/').pop()!;
    const rows = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (rows.length === 0) {
      json(res, 404, { error: 'task not found' });
      return;
    }
    json(res, 200, rows[0]);
    return;
  }

  // API: Memory search
  if (url.pathname === '/api/memory' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    if (!q) {
      json(res, 400, { error: 'q parameter required' });
      return;
    }
    const results = await recallMemory({ query: q, limit: 10 });
    json(res, 200, results);
    return;
  }

  // API: Away Mode start
  if (url.pathname === '/api/away/start' && req.method === 'POST') {
    let body: { goals?: string[]; policy?: Partial<AwayModePolicy> };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: 'invalid JSON body' });
      return;
    }
    const goals = body.goals as string[];
    if (!goals?.length) {
      json(res, 400, { error: 'goals array required' });
      return;
    }
    startAwayMode(goals, body.policy, queue).catch((err) =>
      logger.error({ err }, 'away mode failed')
    );
    json(res, 202, { status: 'started', taskCount: goals.length });
    return;
  }

  // API: Away Mode stop
  if (url.pathname === '/api/away/stop' && req.method === 'POST') {
    await stopAwayMode();
    json(res, 200, { status: 'stopped' });
    return;
  }

  // API: Away Mode status
  if (url.pathname === '/api/away/status' && req.method === 'GET') {
    json(res, 200, getAwayModeStatus());
    return;
  }

  // API: Learning stats
  if (url.pathname === '/api/learning' && req.method === 'GET') {
    json(res, 200, learning.getSummary());
    return;
  }

  // API: Agent suggestion for a goal
  if (url.pathname === '/api/suggest' && req.method === 'GET') {
    const goal = url.searchParams.get('goal') || '';
    if (!goal) {
      json(res, 400, { error: 'goal parameter required' });
      return;
    }
    const suggestion = learning.suggestAgent(goal);
    json(res, 200, { goal, suggestedAgent: suggestion });
    return;
  }

  // API: Queue pause
  if (url.pathname === '/api/queue/pause' && req.method === 'POST') {
    queue.pause();
    json(res, 200, { status: 'paused', stats: queue.getStats() });
    return;
  }

  // API: Queue resume
  if (url.pathname === '/api/queue/resume' && req.method === 'POST') {
    queue.resume();
    json(res, 200, { status: 'resumed', stats: queue.getStats() });
    return;
  }

  // API: List pending approvals
  if (url.pathname === '/api/approvals' && req.method === 'GET') {
    const approvals = await getPendingApprovals();
    json(res, 200, approvals);
    return;
  }

  // API: Approve a request
  if (url.pathname.match(/^\/api\/approvals\/[^/]+\/approve$/) && req.method === 'POST') {
    const id = url.pathname.split('/')[3];
    await resolveApproval(id, true);
    json(res, 200, { ok: true });
    return;
  }

  // API: Reject a request
  if (url.pathname.match(/^\/api\/approvals\/[^/]+\/reject$/) && req.method === 'POST') {
    const id = url.pathname.split('/')[3];
    await resolveApproval(id, false);
    json(res, 200, { ok: true });
    return;
  }

  // API: Retry a failed task
  if (url.pathname === '/api/task/retry' && req.method === 'POST') {
    let body: { taskId?: string };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: 'invalid JSON body' });
      return;
    }
    const taskId = body.taskId as string;
    if (!taskId) {
      json(res, 400, { error: 'taskId required' });
      return;
    }
    const success = await queue.retry(taskId);
    if (!success) {
      json(res, 404, { error: 'task not found or not in failed state' });
      return;
    }
    json(res, 202, { taskId, status: 'retrying' });
    return;
  }

  // ── Projects ────────────────────────────────────────────────────────────────

  // GET /api/projects
  if (url.pathname === '/api/projects' && req.method === 'GET') {
    json(res, 200, await listProjects());
    return;
  }

  // POST /api/projects
  if (url.pathname === '/api/projects' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.name?.trim() || !body.goal?.trim()) {
        json(res, 400, { error: 'name and goal are required' });
        return;
      }
      const project = await createProject(body.name, body.goal);
      json(res, 201, project);
    } catch {
      json(res, 400, { error: 'invalid JSON body' });
    }
    return;
  }

  // GET /api/projects/:id
  if (url.pathname.match(/^\/api\/projects\/[^/]+$/) && req.method === 'GET') {
    const id = url.pathname.split('/').pop()!;
    const project = await getProject(id);
    if (!project) {
      json(res, 404, { error: 'project not found' });
      return;
    }
    json(res, 200, project);
    return;
  }

  // PATCH /api/projects/:id/status
  if (url.pathname.match(/^\/api\/projects\/[^/]+\/status$/) && req.method === 'PATCH') {
    try {
      const id = url.pathname.split('/')[3];
      const body = JSON.parse(await readBody(req));
      if (!body.status) {
        json(res, 400, { error: 'status is required' });
        return;
      }
      await updateProjectStatus(id, body.status);
      json(res, 200, { ok: true, id, status: body.status });
    } catch {
      json(res, 400, { error: 'invalid JSON body' });
    }
    return;
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────────

  // GET /api/webhooks
  if (url.pathname === '/api/webhooks' && req.method === 'GET') {
    json(res, 200, await listWebhooks());
    return;
  }

  // POST /api/webhooks
  if (url.pathname === '/api/webhooks' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.url?.trim()) {
        json(res, 400, { error: 'url is required' });
        return;
      }
      const hook = await registerWebhook(body.url, body.events ?? [], body.secret);
      json(res, 201, hook);
    } catch {
      json(res, 400, { error: 'invalid JSON body' });
    }
    return;
  }

  // DELETE /api/webhooks/:id
  if (url.pathname.match(/^\/api\/webhooks\/[^/]+$/) && req.method === 'DELETE') {
    const id = url.pathname.split('/').pop()!;
    await deleteWebhook(id);
    json(res, 200, { ok: true });
    return;
  }

  json(res, 404, { error: 'not found' });
});

async function start() {
  try {
    await redis.connect();
  } catch {
    logger.warn('Redis connection deferred — will retry on health check');
  }

  // Ensure the default project exists
  await ensureDefaultProject();

  // Load learning data from DB
  await learning.loadFromDb();

  // Initialize MCP tools BEFORE serving — worker agents are constructed per-task
  // in core.ts, so bridged MCP tools must be in TOOL_MAP before the first task.
  await initMcp();

  // Initialize SSE event stream subscriber
  initEventStream();

  server.listen(PORT, () => {
    logger.info({ port: PORT }, 'UAI Runtime server started');
  });
}

start();

// Graceful shutdown — MCP alt-süreçlerini kapat (sızdırma önle)
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    logger.info({ sig }, 'shutting down');
    void shutdownMcp().finally(() => process.exit(0));
  });
}
