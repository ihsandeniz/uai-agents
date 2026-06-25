import { db } from '../db.js';
import { webhooks } from '@uai/db/schema';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { logger } from '../logger.js';

export interface WebhookRecord {
  id: string;
  url: string;
  events: string[];
  secret: string | null;
  active: number;
  failCount: number;
  createdAt: Date | null;
  lastTriggeredAt: Date | null;
}

export async function registerWebhook(
  url: string,
  events: string[],
  secret?: string,
): Promise<WebhookRecord> {
  const id = ulid();
  await db.insert(webhooks).values({ id, url, events, secret: secret ?? null });
  logger.info({ id, url, events }, 'webhook registered');
  return {
    id, url, events, secret: secret ?? null,
    active: 1, failCount: 0,
    createdAt: new Date(), lastTriggeredAt: null,
  };
}

export async function listWebhooks(): Promise<WebhookRecord[]> {
  const rows = await db.select().from(webhooks);
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    events: (r.events as string[]) ?? [],
    secret: r.secret,
    active: r.active,
    failCount: r.failCount,
    createdAt: r.createdAt,
    lastTriggeredAt: r.lastTriggeredAt,
  }));
}

export async function deleteWebhook(id: string): Promise<boolean> {
  await db.delete(webhooks).where(eq(webhooks.id, id));
  logger.info({ id }, 'webhook deleted');
  return true;
}

/**
 * Fire-and-forget POST to all active webhooks subscribed to `event`.
 * Failures increment failCount; after 5 consecutive failures the hook is deactivated.
 */
export async function dispatchWebhooks(
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const rows = await db.select().from(webhooks).where(eq(webhooks.active, 1));

  const matching = rows.filter((r) => {
    const evts = (r.events as string[]) ?? [];
    return evts.length === 0 || evts.includes(event);
  });

  if (matching.length === 0) return;

  const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });

  await Promise.allSettled(
    matching.map(async (hook) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (hook.secret) headers['X-UAI-Secret'] = hook.secret;

        const res = await fetch(hook.url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        // Reset fail count on success
        await db.update(webhooks)
          .set({ failCount: 0, lastTriggeredAt: new Date() })
          .where(eq(webhooks.id, hook.id));

        logger.debug({ hookId: hook.id, event }, 'webhook dispatched');
      } catch (err) {
        const newFailCount = hook.failCount + 1;
        const updates: Record<string, unknown> = { failCount: newFailCount };
        if (newFailCount >= 5) {
          updates.active = 0;
          logger.warn({ hookId: hook.id, failCount: newFailCount }, 'webhook deactivated after 5 failures');
        }
        await db.update(webhooks).set(updates).where(eq(webhooks.id, hook.id));
        logger.warn({ hookId: hook.id, event, err: String(err) }, 'webhook dispatch failed');
      }
    }),
  );
}
