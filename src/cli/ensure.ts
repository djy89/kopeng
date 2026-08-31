/**
 * `kopeng ensure` (Task 2.3.3, Install Strategy §4.3) — the other half of
 * keeping the packaged server alive with zero admin rights (the other half
 * is user-level autostart, src/cli/autostart.ts). Meant to be fired
 * fire-and-forget from the SessionStart hook on every prompt: probe the
 * health endpoint, and if nothing answers, launch a detached server and
 * return immediately. Never waits for the spawned server to become ready —
 * a cold first prompt missing recall is accepted; it self-heals by the next
 * prompt once the server has started.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import dotenv from 'dotenv';

import { APP_DIR, KOPENG_HOME } from './paths.js';
import { RESOLVED_ENV_FILE } from '../config/config.js';

export type EnsureDecision = 'already-up' | 'spawn' | 'port-conflict' | 'spawn-suppressed';

/** What the health probe actually saw — collapsed to just what decideEnsure needs. */
export type ProbeResult =
  | { kind: 'response'; body: unknown }
  /** Nothing is bound to the port (connection refused). The ONLY safe-to-spawn state. */
  | { kind: 'no-listener' }
  /** Something accepted the TCP connection but never answered — live, just busy. */
  | { kind: 'listener-silent' };

const DEFAULT_PORT = 3200;
const PROBE_TIMEOUT_MS = 500;
/**
 * Second-chance health budget, used ONLY once the TCP probe has proved
 * something is bound to the port. A live server whose event loop is briefly
 * occupied (ONNX session creation, a large trimAccessLog DELETE, an
 * un-memoized ops recompute) misses 500ms, and the old probe read that as an
 * empty port and got a competitor spawned on top of it — the slower the
 * server, the more spawns it attracted. Paying up to 2.5s more here is free:
 * this CLI runs detached from the SessionStart hook, which never waits on it.
 */
const SLOW_PROBE_TIMEOUT_MS = 2500;
/** A loopback connect either completes or is refused at once; this is only a stuck-syscall guard. */
const PORT_OPEN_TIMEOUT_MS = 300;

/**
 * How long one spawn suppresses the next — a boot budget, not a rate limit.
 * A cold boot does all of its expensive work BEFORE binding (getDatabase()'s
 * migration ladder, embeddingIndex.loadFromDatabase() over the whole corpus,
 * trimAccessLog's retention DELETE), so for those seconds the port is still
 * refused and every SessionStart — startup, --resume, /clear, every
 * auto-compact, times every concurrent session on the machine — probed an
 * empty port and spawned yet another server that opened the live memory.db /
 * observations.db, re-ran migrations and re-read every embedding before
 * finally dying on EADDRINUSE. That is N concurrent writers on the exact
 * SQLite files the 3s recall hook depends on; this marker bounds it to one.
 * A boot slower than the budget can still attract a second spawn — the
 * complete fix is binding before the expensive work, which is server.ts's
 * call to make, not ensure's.
 */
const SPAWN_COOLDOWN_MS = 30_000;
const SPAWN_MARKER_FILE = 'ensure_spawn.json';

function isKopengHealthBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const data = (body as Record<string, unknown>).data;
  return typeof data === 'object' && data !== null && 'status' in (data as Record<string, unknown>);
}

/**
 * Pure: classifies a probe result to exactly one decision.
 * - A JSON body carrying `data.status` (any value) IS a KOPENG server → 'already-up'.
 * - Nothing bound to the port at all → 'spawn'.
 * - Bound but silent within the budget → 'already-up': a live process holds
 *   the port, and a probe timeout says nothing about WHO — so we neither
 *   spawn on top of it nor accuse it of being foreign. The next session start
 *   re-probes for free.
 * - Any other HTTP response (garbage body, wrong shape, non-JSON) → a foreign
 *   process already holds the port → 'port-conflict'. A crash-looping server
 *   behind a taken port is worse than no server.
 *
 * The guarantee this encodes: a spawn happens ONLY on positive evidence that
 * the port is empty. The comment here used to claim as much, but the probe
 * collapsed connection-refused and timeout into one 'network-error' kind, so
 * a busy live server was indistinguishable from an absent one and the
 * guarantee held only for responses that ARRIVED.
 */
export function decideEnsure(probe: ProbeResult): EnsureDecision {
  if (probe.kind === 'no-listener') return 'spawn';
  if (probe.kind === 'listener-silent') return 'already-up';
  return isKopengHealthBody(probe.body) ? 'already-up' : 'port-conflict';
}

export interface EnsureFetchResponse {
  json(): Promise<unknown>;
}
export type EnsureFetch = (url: string, init: { signal: AbortSignal }) => Promise<EnsureFetchResponse>;

export interface EnsureSpawnResult {
  unref(): void;
}
export type EnsureSpawn = (command: string, args: string[], options: SpawnOptions) => EnsureSpawnResult;

/** Resolves true iff something accepts a loopback TCP connection on `port`. */
export type EnsurePortOpenProbe = (port: number) => Promise<boolean>;

export interface EnsureDeps {
  port: number;
  nodePath: string;
  serverEntry: string;
  kopengHome: string;
  envFile: string;
  hintsDir: string;
  fetchImpl: EnsureFetch;
  spawnImpl: EnsureSpawn;
  writeFile: (filePath: string, content: string) => void;
  /**
   * Optional: absent ⇒ a failed health probe is read as an empty port, the
   * pre-fix behavior. Only the hook-driven CLI path (`currentEnsureDeps`)
   * wires the real probe; init/update deliberately do not — they are explicit
   * operator restarts that must START a server, not defer to whatever holds
   * the port.
   */
  portOpenImpl?: EnsurePortOpenProbe;
  /**
   * Optional BY DESIGN, same reasoning as `portOpenImpl`: the spawn-cooldown
   * marker is only READ where a reader is wired, so `kopeng init` / `kopeng
   * update` can never be blocked from starting the server by a marker some
   * SessionStart wrote seconds earlier. Both of those still WRITE the marker
   * (through `writeFile`), so a concurrent hook spawn stands down for them.
   */
  readFile?: (filePath: string) => string;
  now?: () => Date;
}

async function fetchHealth(
  port: number,
  fetchImpl: EnsureFetch,
  timeoutMs: number
): Promise<{ answered: true; body: unknown } | { answered: false }> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined; // non-JSON response body — falls through to port-conflict
    }
    return { answered: true, body };
  } catch {
    return { answered: false };
  }
}

async function probeHealth(deps: EnsureDeps): Promise<ProbeResult> {
  const fast = await fetchHealth(deps.port, deps.fetchImpl, PROBE_TIMEOUT_MS);
  if (fast.answered) return { kind: 'response', body: fast.body };

  // Silence is not emptiness. Ask the kernel who actually holds the port
  // before treating this as "nothing is listening".
  if (!deps.portOpenImpl) return { kind: 'no-listener' };
  let open: boolean;
  try {
    open = await deps.portOpenImpl(deps.port);
  } catch {
    // Unknown ⇒ assume occupied. Declining to spawn costs one prompt of
    // recall; spawning wrongly costs concurrent writers on the live DBs.
    open = true;
  }
  if (!open) return { kind: 'no-listener' };

  // Bound, but slow: give it a real budget so a busy KOPENG is still
  // classified honestly as already-up, and a foreign HTTP server that answers
  // garbage a beat later still earns its port-conflict hint.
  const slow = await fetchHealth(deps.port, deps.fetchImpl, SLOW_PROBE_TIMEOUT_MS);
  return slow.answered ? { kind: 'response', body: slow.body } : { kind: 'listener-silent' };
}

/**
 * True while a spawn from the last SPAWN_COOLDOWN_MS is presumed to still be
 * booting. Fail-open in every direction — an absent, unreadable, malformed or
 * future-dated marker never suppresses; the worst outcome of this check
 * failing must be today's behavior, never a server that can no longer start.
 */
function spawnIsCoolingDown(deps: EnsureDeps, now: Date): boolean {
  if (!deps.readFile) return false;
  try {
    const parsed = JSON.parse(deps.readFile(path.join(deps.hintsDir, SPAWN_MARKER_FILE))) as { timestamp?: unknown };
    const stampedMs = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN;
    if (!Number.isFinite(stampedMs)) return false;
    const age = now.getTime() - stampedMs;
    // A negative age is a clock-skewed (future) marker — treated as expired so
    // it cannot suppress spawns forever.
    return age >= 0 && age < SPAWN_COOLDOWN_MS;
  } catch {
    return false;
  }
}

/**
 * Probes, decides, and (on 'spawn') launches a detached server — returning
 * IMMEDIATELY after the spawn call with no readiness wait.
 */
export async function runEnsure(deps: EnsureDeps): Promise<EnsureDecision> {
  const probe = await probeHealth(deps);
  const decision = decideEnsure(probe);
  const now = deps.now ? deps.now() : new Date();

  if (decision === 'port-conflict') {
    const hint = {
      port: deps.port,
      reason: 'a non-KOPENG process is already listening on this port',
      timestamp: now.toISOString(),
    };
    try {
      // `kopeng doctor` reads this back (checkEnsureConflictHint, doctor.ts)
      // and WARNs while it's fresh (<24h) — a write failure here just means
      // that check finds nothing, same as a stale or absent hint.
      deps.writeFile(path.join(deps.hintsDir, 'ensure_conflict.json'), JSON.stringify(hint));
    } catch {
      /* best-effort — doctor simply won't see the hint */
    }
    return decision;
  }

  if (decision === 'spawn') {
    if (spawnIsCoolingDown(deps, now)) return 'spawn-suppressed';
    try {
      // Marked BEFORE the spawn, deliberately: a stampede is exactly the case
      // where the marker has to be on disk by the time the next invocation
      // probes, and if the spawn itself throws we would rather stand down for
      // the cooldown than have every session retry it at once.
      deps.writeFile(
        path.join(deps.hintsDir, SPAWN_MARKER_FILE),
        JSON.stringify({ port: deps.port, timestamp: now.toISOString() })
      );
    } catch {
      /* best-effort — an unwritable marker degrades to the old spawn-every-time behavior */
    }
    const child = deps.spawnImpl(deps.nodePath, [deps.serverEntry], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, KOPENG_ENV_FILE: deps.envFile, KOPENG_HOME: deps.kopengHome },
      cwd: deps.kopengHome,
    });
    child.unref();
  }

  return decision;
}

// ── Real wiring (never invoked by tests) ────────────────────────────────────

/** Reads PORT out of the resolved .env directly (dotenv.parse, no process.env
 *  mutation) — ensure is a lightweight, self-contained fire-and-forget CLI
 *  call and shouldn't need the full config.ts side effects to answer "what
 *  port". */
function readPort(envFile: string): number {
  try {
    const parsed = dotenv.parse(fs.readFileSync(envFile, 'utf8'));
    const n = parsed.PORT ? parseInt(parsed.PORT, 10) : NaN;
    return Number.isFinite(n) ? n : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

function realWriteFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

/** Loopback connect: true if the port is held, false ONLY on an outright refusal. */
function realPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(PORT_OPEN_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    // A loopback connect that neither completes nor is refused is an anomaly,
    // not an empty port — same conservative side as the catch above.
    socket.once('timeout', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Real-environment deps for the CLI's `ensure` invocation. */
export function currentEnsureDeps(): EnsureDeps {
  return {
    port: readPort(RESOLVED_ENV_FILE),
    nodePath: process.execPath,
    serverEntry: path.join(APP_DIR, 'node_modules', 'kopeng', 'dist', 'server.js'),
    kopengHome: KOPENG_HOME,
    envFile: RESOLVED_ENV_FILE,
    hintsDir: process.env.KOPENG_HINTS_DIR || path.join(KOPENG_HOME, 'hints'),
    fetchImpl: (url, init) => fetch(url, init),
    spawnImpl: (command, args, options) => spawn(command, args, options),
    writeFile: realWriteFile,
    portOpenImpl: realPortOpen,
    readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
  };
}
