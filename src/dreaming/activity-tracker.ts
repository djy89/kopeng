/**
 * Activity tracker (D0.5) — the single source of "when did the operator last do
 * something". The Fastify `onRequest` hook stamps it on real requests (excluding
 * dream/ops/health polling, which would otherwise keep the system looking awake
 * forever); the DreamScheduler reads it to decide whether the operator is idle.
 *
 * Deliberately trivial: one mutable epoch-ms field behind get/stamp. The clock is
 * injectable so tests assert stamping without touching the wall clock.
 */
export class ActivityTracker {
  private lastActivityAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Record operator activity at the current (injected) time. */
  stamp(): void {
    this.lastActivityAt = this.now();
  }

  /** Epoch ms of the last stamped activity, or null if none seen. */
  get(): number | null {
    return this.lastActivityAt;
  }
}

/**
 * Should a request path count as operator activity? Dreaming-internal,
 * operational, and health endpoints are excluded so background polling (the viz
 * ops tab, health checks, the dream tools themselves) never resets the idle clock.
 */
export function isActivityPath(method: string, url: string): boolean {
  // Strip query string for prefix matching.
  const path = url.split('?')[0];
  const EXCLUDED_PREFIXES = [
    '/api/health',
    '/api/ops/',
    '/api/dreams', // dream trigger/list/resolve — internal, not operator "work"
    '/api/observations/stream', // SSE heartbeat traffic
  ];
  if (EXCLUDED_PREFIXES.some(p => path === p || path.startsWith(p))) return false;
  // Slot READS are background traffic (the viz slots tab polls GET /api/slots
  // every 30s); slot WRITES are real operator work and still count.
  if (method === 'GET' && (path === '/api/slots' || path.startsWith('/api/slots/'))) return false;
  // Everything else (memory CRUD, search, recall, ingestion, context, artifacts) counts.
  return true;
}
