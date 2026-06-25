import type { IncomingMessage } from 'node:http';
import { redis } from '../redis.js';
import { logger } from '../logger.js';

interface Window {
  count: number;
  resetAt: number;
}

// In-memory fallback — active when Redis is unavailable
const _fallback = new Map<string, Window>();
setInterval(() => {
  const now = Date.now();
  for (const [key, w] of _fallback) {
    if (now > w.resetAt) _fallback.delete(key);
  }
}, 60_000).unref();

function _fallbackCheck(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const w = _fallback.get(key);
  if (!w || now > w.resetAt) {
    _fallback.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (w.count >= limit) return false;
  w.count++;
  return true;
}

function _getIp(req: IncomingMessage): string {
  return (
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? req.socket.remoteAddress
    ?? 'unknown'
  );
}

async function _redisCheck(key: string, limit: number, windowSec: number): Promise<boolean> {
  const count = await redis.incr(key);
  if (count === 1) {
    // Only set TTL on first increment — avoids resetting the window on every request
    await redis.expire(key, windowSec);
  }
  return count <= limit;
}

/**
 * Redis-backed rate limiter with in-memory fallback.
 * Default: 120 requests / 60 s per IP per bucket.
 */
export async function checkRateLimit(
  req: IncomingMessage,
  limit = 120,
  windowMs = 60_000,
  bucket = 'general',
): Promise<boolean> {
  const ip = _getIp(req);
  const key = `rl:${bucket}:${ip}`;
  const windowSec = Math.ceil(windowMs / 1000);

  try {
    return await _redisCheck(key, limit, windowSec);
  } catch (err) {
    logger.warn({ err }, 'Redis rate limit unavailable — falling back to memory');
    return _fallbackCheck(key, limit, windowMs);
  }
}

/** Stricter limit for expensive write endpoints (task submission, away mode). */
export async function checkStrictRateLimit(req: IncomingMessage): Promise<boolean> {
  return checkRateLimit(req, 20, 60_000, 'strict');
}
