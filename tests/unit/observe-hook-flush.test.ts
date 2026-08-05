/**
 * T18 — observe-hook flush rework unit suite.
 *
 * Covers the failure modes of a real multi-week silent flush outage:
 *  - byte-only chunking violating the server's 100-item batch cap (the
 *    persistent post-T10 wedge: the first backlog chunk 400'd forever),
 *  - all-or-nothing progress (a failed/killed invocation committed nothing),
 *  - unbounded inline parsing of an arbitrarily large buffer,
 *  - silent failure (no operator-visible signal).
 *
 * The hook module reads KOPENG_BUFFER_DIR / KOPENG_HINTS_DIR at import time,
 * so env points at a temp dir BEFORE the dynamic import below.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// IMPORTANT: env must be set BEFORE the dynamic import in beforeAll — the hook
// binds BUFFER_DIR/HINTS_DIR at module load. Safe under vitest's default
// per-file isolation; if isolation were ever disabled and another file imported
// the hook first, these consts would bind to the operator's REAL ~/.kopeng.
const tmp = mkdtempSync(join(tmpdir(), 'kopeng-t18-'));
const BUFFER_DIR = join(tmp, 'buffer');
const HINTS_DIR = join(tmp, 'hints');
process.env.KOPENG_BUFFER_DIR = BUFFER_DIR;
process.env.KOPENG_HINTS_DIR = HINTS_DIR;

const BUFFER_FILE = join(BUFFER_DIR, 'observations.jsonl');
const HINT_FILE = join(HINTS_DIR, 'flush_error.json');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let hook: any;

function makeEntry(i: number, pad = 0) {
  return {
    idempotency_key: `k-${i}`,
    session_id: 's1',
    project_scope: 'project:t18',
    tool_name: 'Bash',
    event_type: 'tool_complete',
    input_summary: pad > 0 ? 'x'.repeat(pad) : `cmd-${i}`,
    output_summary: 'ok',
    metadata: {},
    _buffered_at: new Date().toISOString(),
  };
}

function writeFlushFile(name: string, entries: unknown[]) {
  mkdirSync(BUFFER_DIR, { recursive: true });
  writeFileSync(join(BUFFER_DIR, name), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function cleanDirs() {
  for (const dir of [BUFFER_DIR, HINTS_DIR]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
    }
  }
}

beforeAll(async () => {
  hook = await import('../../scripts/hooks/kopeng-observe.js');
});

beforeEach(() => {
  mkdirSync(BUFFER_DIR, { recursive: true });
  mkdirSync(HINTS_DIR, { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanDirs();
});

describe('chunkObservations', () => {
  it('caps chunks at 100 items regardless of byte size (the post-T10 wedge)', () => {
    const obs = Array.from({ length: 250 }, (_, i) => makeEntry(i));
    const chunks = hook.chunkObservations(obs);
    expect(chunks.length).toBe(3); // 100 + 100 + 50
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.flat()).toHaveLength(250); // nothing dropped
  });

  it('still splits by byte budget below the item cap', () => {
    const obs = Array.from({ length: 6 }, (_, i) => makeEntry(i, 400));
    const chunks = hook.chunkObservations(obs, { maxBytes: 1000 });
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2);
    expect(chunks.flat()).toHaveLength(6);
  });

  it('emits a single oversized observation as its own chunk rather than dropping it', () => {
    const chunks = hook.chunkObservations([makeEntry(1, 2000), makeEntry(2, 2000)], { maxBytes: 1000 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(1);
  });
});

describe('drainPendingFlushes', () => {
  it('drains a pending file, strips buffer-local fields, and clears the failure hint', async () => {
    writeFlushFile('flush-0001.jsonl', Array.from({ length: 5 }, (_, i) => makeEntry(i)));
    hook.writeFlushErrorHint({ reason: 'test' });
    expect(existsSync(HINT_FILE)).toBe(true);

    const calls: Array<{ observations: Record<string, unknown>[] }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 201 };
    }));

    const drained = await hook.drainPendingFlushes();
    expect(drained).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].observations).toHaveLength(5);
    expect(calls[0].observations[0].idempotency_key).toBe('k-0');
    expect(calls[0].observations[0]).not.toHaveProperty('_buffered_at');
    expect(hook.listPendingFlushFiles()).toHaveLength(0);
    expect(existsSync(HINT_FILE)).toBe(false);
  });

  it('commits partial progress on failure — the remainder survives, the hint is written', async () => {
    writeFlushFile('flush-0001.jsonl', Array.from({ length: 250 }, (_, i) => makeEntry(i)));

    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++;
      return call === 1 ? { ok: true, status: 201 } : { ok: false, status: 500 };
    }));

    const drained = await hook.drainPendingFlushes();
    expect(drained).toBe(false);

    // First chunk (100) accepted and committed; 150 remain on disk.
    const files = hook.listPendingFlushFiles();
    expect(files).toHaveLength(1);
    const remaining = readFileSync(files[0], 'utf-8').trim().split('\n');
    expect(remaining).toHaveLength(150);
    expect(JSON.parse(remaining[0]).idempotency_key).toBe('k-100');

    const hint = JSON.parse(readFileSync(HINT_FILE, 'utf-8'));
    expect(hint.reason).toBe('rejected');
    expect(hint.status).toBe(500);
    expect(hint.pending_bytes).toBeGreaterThan(0);
  });

  it('bounds per-invocation work and resumes across invocations', async () => {
    writeFlushFile('flush-0001.jsonl', Array.from({ length: 500 }, (_, i) => makeEntry(i)));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201 })));

    // Invocation 1: default budget = 3 chunks (300 items); 200 remain.
    expect(await hook.drainPendingFlushes()).toBe(false);
    let files = hook.listPendingFlushFiles();
    expect(files).toHaveLength(1);
    expect(readFileSync(files[0], 'utf-8').trim().split('\n')).toHaveLength(200);

    // Invocation 2: the rest drains; queue empty.
    expect(await hook.drainPendingFlushes()).toBe(true);
    expect(hook.listPendingFlushFiles()).toHaveLength(0);
  });

  it('quarantines a 4xx-rejected chunk and keeps draining — no poison wedge', async () => {
    writeFlushFile('flush-0001.jsonl', Array.from({ length: 150 }, (_, i) => makeEntry(i)));
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++;
      return call === 1 ? { ok: false, status: 400 } : { ok: true, status: 201 };
    }));

    const drained = await hook.drainPendingFlushes();
    // Chunk 1 (100 items) 400'd → parked as poison; chunk 2 (50) sent fine.
    expect(hook.listPendingFlushFiles()).toHaveLength(0);
    const poison = readdirSync(BUFFER_DIR).filter((n: string) => n.startsWith('poison-'));
    expect(poison).toHaveLength(1);
    expect(readFileSync(join(BUFFER_DIR, poison[0]), 'utf-8').trim().split('\n')).toHaveLength(100);
    // Parked data keeps the alarm up (drain reports not-fully-clear).
    expect(drained).toBe(false);
    expect(existsSync(HINT_FILE)).toBe(true);
  });

  it('does not quarantine on transient failures (429/5xx/network) — those retry', async () => {
    writeFlushFile('flush-0001.jsonl', Array.from({ length: 50 }, (_, i) => makeEntry(i)));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429 })));

    expect(await hook.drainPendingFlushes()).toBe(false);
    expect(hook.listPendingFlushFiles()).toHaveLength(1); // everything retained for retry
    expect(readdirSync(BUFFER_DIR).some((n: string) => n.startsWith('poison-'))).toBe(false);
  });

  it('rotates the oldest pending files to overflow past the total-bytes cap', async () => {
    writeFlushFile('flush-0001.jsonl', Array.from({ length: 20 }, (_, i) => makeEntry(i, 200)));
    writeFlushFile('flush-0002.jsonl', Array.from({ length: 20 }, (_, i) => makeEntry(100 + i, 200)));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201 })));

    const drained = await hook.drainPendingFlushes({ pendingMaxBytes: 1000 });
    const names = readdirSync(BUFFER_DIR);
    expect(names.some((n: string) => n.startsWith('overflow-'))).toBe(true);
    // The newest file stayed inline (and drained).
    expect(names.some((n: string) => n.startsWith('flush-'))).toBe(false);
    // Parked overflow data keeps the alarm up until recovered out-of-band.
    expect(drained).toBe(false);
    const hint = JSON.parse(readFileSync(HINT_FILE, 'utf-8'));
    expect(hint.reason).toBe('overflow-pending');
    expect(hint.pending_bytes).toBeGreaterThan(0);
  });
});

describe('drainPendingFlushes parked-data epilogue', () => {
  it('keeps the alarm fresh (and regenerates a deleted hint) while only parked files remain', async () => {
    // No flush queue — just a parked overflow file and NO hint on disk.
    writeFlushFile('overflow-0001.jsonl', [makeEntry(1)]);
    expect(existsSync(HINT_FILE)).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201 })));
    const drained = await hook.drainPendingFlushes();

    expect(drained).toBe(false); // parked data = not clear
    const hint = JSON.parse(readFileSync(HINT_FILE, 'utf-8'));
    expect(hint.reason).toBe('overflow-pending');
    expect(hint.pending_bytes).toBeGreaterThan(0);
  });
});

describe('maybeRotateForFlush', () => {
  it('rotates an oversized buffer to overflow without parsing it', () => {
    writeFileSync(BUFFER_FILE, 'x'.repeat(500)); // not even valid JSONL — must not matter
    const result = hook.maybeRotateForFlush({ inlineMaxBytes: 100 });
    expect(result).toBe('overflow');
    expect(existsSync(BUFFER_FILE)).toBe(false);
    expect(readdirSync(BUFFER_DIR).some((n: string) => n.startsWith('overflow-'))).toBe(true);
    const hint = JSON.parse(readFileSync(HINT_FILE, 'utf-8'));
    expect(hint.reason).toBe('overflow-rotated');
    expect(hint.pending_bytes).toBe(500);
  });

  it('rotates a flush-due buffer into the pending queue', () => {
    writeFlushFile('observations.jsonl', Array.from({ length: 25 }, (_, i) => makeEntry(i)));
    const result = hook.maybeRotateForFlush();
    expect(result).toBe('rotated');
    expect(existsSync(BUFFER_FILE)).toBe(false);
    expect(hook.listPendingFlushFiles()).toHaveLength(1);
  });

  it('leaves a small fresh buffer alone', () => {
    writeFlushFile('observations.jsonl', [makeEntry(1), makeEntry(2)]);
    expect(hook.maybeRotateForFlush()).toBeNull();
    expect(existsSync(BUFFER_FILE)).toBe(true);
  });
});
