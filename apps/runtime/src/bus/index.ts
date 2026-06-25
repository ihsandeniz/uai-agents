import type { AgentName, AgentMessage, MessageType } from '@uai/shared';
import Redis from 'ioredis';
import { logger } from '../logger.js';
import { ulid } from 'ulid';
import { db } from '../db.js';
import { agentMessages } from '@uai/db/schema';

const CHANNEL = 'uai:messages';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';

// Separate pub/sub connections (Redis requires it)
let publisher: Redis | null = null;
let subscriber: Redis | null = null;

type MessageHandler = (msg: AgentMessage) => void | Promise<void>;
const handlers = new Map<string, MessageHandler[]>();

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });
    publisher.connect().catch((err) => logger.error({ err }, 'bus publisher connect failed'));
  }
  return publisher;
}

function getSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });
    subscriber.connect().catch((err) => logger.error({ err }, 'bus subscriber connect failed'));

    subscriber.subscribe(CHANNEL, (err) => {
      if (err) logger.error({ err }, 'bus subscribe failed');
      else logger.info('bus subscribed to ' + CHANNEL);
    });

    subscriber.on('message', (_channel, raw) => {
      try {
        const msg = JSON.parse(raw) as AgentMessage;
        // Deliver to handlers registered for this target
        const targets = [msg.to, 'broadcast'];
        for (const target of targets) {
          const fns = handlers.get(target) ?? [];
          for (const fn of fns) {
            Promise.resolve(fn(msg)).catch((err) =>
              logger.error({ err, agent: target }, 'bus handler error')
            );
          }
        }
      } catch (err) {
        logger.error({ err, raw }, 'bus message parse error');
      }
    });
  }
  return subscriber;
}

/** Send a message through the bus */
export async function send(
  from: AgentName,
  to: AgentName | 'broadcast',
  type: MessageType,
  payload: unknown,
  taskId?: string
): Promise<AgentMessage> {
  const msg: AgentMessage = {
    id: ulid(),
    from,
    to,
    type,
    taskId,
    payload,
    timestamp: new Date(),
  };

  // Persist to DB
  await db.insert(agentMessages).values({
    id: msg.id,
    fromAgent: msg.from,
    toAgent: msg.to,
    type: msg.type,
    taskId: msg.taskId,
    payload: msg.payload,
    timestamp: msg.timestamp,
  });

  // Publish to Redis
  await getPublisher().publish(CHANNEL, JSON.stringify(msg));

  logger.debug({ from, to, type, id: msg.id }, 'bus message sent');
  return msg;
}

/** Subscribe to messages for a specific agent */
export function subscribe(agent: AgentName | 'broadcast', handler: MessageHandler): () => void {
  // Ensure subscriber is initialized
  getSubscriber();

  const existing = handlers.get(agent) ?? [];
  existing.push(handler);
  handlers.set(agent, existing);

  logger.info({ agent }, 'bus handler registered');

  // Return unsubscribe function
  return () => {
    const fns = handlers.get(agent) ?? [];
    const idx = fns.indexOf(handler);
    if (idx >= 0) fns.splice(idx, 1);
  };
}

/** Cleanup connections */
export async function closeBus(): Promise<void> {
  if (subscriber) {
    await subscriber.unsubscribe(CHANNEL);
    subscriber.disconnect();
    subscriber = null;
  }
  if (publisher) {
    publisher.disconnect();
    publisher = null;
  }
  handlers.clear();
}
