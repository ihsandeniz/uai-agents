import type { IncomingMessage } from 'node:http';

/**
 * Paths that bypass API key auth.
 * /health → infra probes
 * /metrics → Prometheus scraper (protect with network rules if needed)
 * NOTE: /api/stream removed from public paths — pass ?key= or X-Api-Key header
 */
const PUBLIC_PATHS = new Set(['/health', '/metrics']);

const UAI_API_KEY = process.env.UAI_API_KEY;

if (!UAI_API_KEY) {
  const env = process.env.NODE_ENV ?? 'development';
  if (env === 'production') {
    console.error('[SECURITY] UAI_API_KEY is not set — refusing to start in production mode.');
    process.exit(1);
  } else {
    console.warn('WARNING: UAI_API_KEY not set — running in open mode');
    console.warn('[SECURITY] This is development-only. Requests will bypass authentication.');
  }
}

/**
 * Returns true when the request is allowed to proceed.
 * If UAI_API_KEY is not set, all requests are allowed (dev mode only).
 */
export function checkAuth(req: IncomingMessage, url: URL): boolean {
  if (!UAI_API_KEY) return true;
  if (PUBLIC_PATHS.has(url.pathname)) return true;

  // Accept key from header OR query param (query param supports SSE browser clients)
  const headerKey = req.headers['x-api-key'];
  const queryKey = url.searchParams.get('key');
  const provided = (Array.isArray(headerKey) ? headerKey[0] : headerKey) ?? queryKey;

  return provided === UAI_API_KEY;
}
