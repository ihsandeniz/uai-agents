import type { IncomingMessage, ServerResponse } from 'node:http';
import { redis } from './redis.js';
import { logger } from './logger.js';
import Redis from 'ioredis';

const EVENT_CHANNEL = 'uai:events';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

// Track connected SSE clients
const clients = new Set<ServerResponse>();

// Dedicated subscriber for events
let eventSub: Redis | null = null;

export interface DashboardEvent {
  type: 'task_started' | 'task_completed' | 'agent_status' | 'memory_saved' | 'qa_review' | 'approval_needed' | 'learning_extracted' | 'heartbeat' | 'queue_paused' | 'queue_resumed' | 'cost_alert';
  data: Record<string, unknown>;
  timestamp: string;
}

/** Publish an event to all SSE clients */
export async function publishEvent(event: Omit<DashboardEvent, 'timestamp'>): Promise<void> {
  const fullEvent: DashboardEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  };

  // Publish to Redis (for multi-instance support)
  try {
    await redis.publish(EVENT_CHANNEL, JSON.stringify(fullEvent));
  } catch {
    // If Redis is down, send directly to local clients
    broadcastToClients(fullEvent);
  }
}

function broadcastToClients(event: DashboardEvent) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

/** Initialize the event subscriber */
export function initEventStream(): void {
  if (eventSub) return;

  eventSub = new Redis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });
  eventSub.connect().then(() => {
    eventSub!.subscribe(EVENT_CHANNEL, (err) => {
      if (err) logger.error({ err }, 'event stream subscribe failed');
      else logger.info('event stream subscriber ready');
    });

    eventSub!.on('message', (_channel, raw) => {
      try {
        const event = JSON.parse(raw) as DashboardEvent;
        broadcastToClients(event);
      } catch (err) {
        logger.error({ err }, 'event stream parse error');
      }
    });
  }).catch((err) => {
    logger.warn({ err }, 'event stream Redis connection failed');
  });
}

/** Handle SSE connection */
export function handleSSE(req: IncomingMessage, res: ServerResponse): void {
  // Add security headers before writeHead
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send connected event
  const connected: DashboardEvent = {
    type: 'heartbeat',
    data: { message: 'connected', clientCount: clients.size + 1 },
    timestamp: new Date().toISOString(),
  };
  res.write(`data: ${JSON.stringify(connected)}\n\n`);

  clients.add(res);
  logger.info({ clientCount: clients.size }, 'SSE client connected');

  // Heartbeat every 30s
  const heartbeat = setInterval(() => {
    try {
      const hb: DashboardEvent = {
        type: 'heartbeat',
        data: { clientCount: clients.size },
        timestamp: new Date().toISOString(),
      };
      res.write(`data: ${JSON.stringify(hb)}\n\n`);
    } catch {
      clearInterval(heartbeat);
      clients.delete(res);
    }
  }, 30_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    logger.info({ clientCount: clients.size }, 'SSE client disconnected');
  });
}
