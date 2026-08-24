import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  evaluateHeartbeats,
  parseExpectOverrides,
  resolveExpectedTasks,
  type ExpectedTask,
} from '../../scripts/ops/heartbeats-report.js';
import {
  expectedTasksPath,
  readExpectedTasks,
  updateExpectedTask,
} from '../../scripts/ops/expected-tasks.mjs';

// Fixed reference clock for every case: 2026-08-21T12:00:00Z.
const NOW = new Date('2026-08-21T12:00:00.000Z');

const EXPECTED: ExpectedTask[] = [
  { task: 'sync-indexes', cadenceHours: 24 },
  { task: 'corpus-health', cadenceHours: 168 },
];

function hb(task: string, ok: boolean, iso: string): string {
  return JSON.stringify({ ts: iso, task, ok });
}

function statusOf(results: ReturnType<typeof evaluateHeartbeats>, task: string) {
  const row = results.find((r) => r.task === task);
  expect(row, `no status row for task ${task}`).toBeDefined();
  return row!;
}

describe('evaluateHeartbeats', () => {
  it('reports ok for a fresh ok:true heartbeat', () => {
    const lines = [hb('sync-indexes', true, '2026-08-21T06:00:00.000Z')]; // 6h ago, cadence 24h
    const res = evaluateHeartbeats(lines, EXPECTED, NOW);
    const row = statusOf(res, 'sync-indexes');
    expect(row.state).toBe('ok');
    expect(row.lastSeen).toBe('2026-08-21T06:00:00.000Z');
    expect(row.lastOk).toBe(true);
  });

  it('reports failing for a fresh ok:false heartbeat', () => {
    const lines = [hb('sync-indexes', false, '2026-08-21T06:00:00.000Z')];
    const res = evaluateHeartbeats(lines, EXPECTED, NOW);
    const row = statusOf(res, 'sync-indexes');
    expect(row.state).toBe('failing');
    expect(row.lastOk).toBe(false);
  });

  it('reports stale when last seen is older than 2x cadence (even if ok:true)', () => {
    // cadence 24h => stale past 48h. 72h ago:
    const lines = [hb('sync-indexes', true, '2026-08-18T12:00:00.000Z')];
    const res = evaluateHeartbeats(lines, EXPECTED, NOW);
    expect(statusOf(res, 'sync-indexes').state).toBe('stale');
  });

  it('is not stale at exactly 2x cadence, stale just past it', () => {
    const atBoundary = [hb('sync-indexes', true, '2026-08-19T12:00:00.000Z')]; // exactly 48h
    expect(statusOf(evaluateHeartbeats(atBoundary, EXPECTED, NOW), 'sync-indexes').state).toBe('ok');
    const pastBoundary = [hb('sync-indexes', true, '2026-08-19T11:59:59.000Z')];
    expect(statusOf(evaluateHeartbeats(pastBoundary, EXPECTED, NOW), 'sync-indexes').state).toBe('stale');
  });

  it('reports missing for an expected task with no heartbeat line ever', () => {
    const lines = [hb('sync-indexes', true, '2026-08-21T06:00:00.000Z')];
    const res = evaluateHeartbeats(lines, EXPECTED, NOW);
    const row = statusOf(res, 'corpus-health');
    expect(row.state).toBe('missing');
    expect(row.lastSeen).toBeNull();
    expect(row.lastOk).toBeNull();
  });

  it('empty input (missing heartbeats file) => every expected task missing', () => {
    const res = evaluateHeartbeats([], EXPECTED, NOW);
    expect(res.map((r) => r.state)).toEqual(['missing', 'missing']);
  });

  it('uses the LATEST heartbeat per task, not the first', () => {
    const lines = [
      hb('sync-indexes', false, '2026-08-20T06:00:00.000Z'),
      hb('sync-indexes', true, '2026-08-21T06:00:00.000Z'),
    ];
    const row = statusOf(evaluateHeartbeats(lines, EXPECTED, NOW), 'sync-indexes');
    expect(row.state).toBe('ok');
    expect(row.lastSeen).toBe('2026-08-21T06:00:00.000Z');
  });

  it('picks the latest by timestamp even when lines are out of append order', () => {
    const lines = [
      hb('sync-indexes', true, '2026-08-21T06:00:00.000Z'),
      hb('sync-indexes', false, '2026-08-20T06:00:00.000Z'),
    ];
    const row = statusOf(evaluateHeartbeats(lines, EXPECTED, NOW), 'sync-indexes');
    expect(row.state).toBe('ok');
  });

  it('skips malformed lines without throwing (bad JSON, wrong shapes, blank lines)', () => {
    const lines = [
      'not json at all',
      '{"ts":"2026-08-21T06:00:00.000Z","task":"sync-indexes"}', // ok field missing
      '{"ts":"garbage-date","task":"sync-indexes","ok":true}', // unparseable ts
      '{"ts":"2026-08-21T06:00:00.000Z","task":42,"ok":true}', // non-string task
      '',
      '   ',
      hb('sync-indexes', true, '2026-08-21T06:00:00.000Z'),
    ];
    const res = evaluateHeartbeats(lines, EXPECTED, NOW);
    expect(statusOf(res, 'sync-indexes').state).toBe('ok');
    expect(statusOf(res, 'corpus-health').state).toBe('missing');
  });

  it('parses the first line of a BOM-prefixed file (PS 5.1 -Encoding utf8 writes a BOM on create)', () => {
    const lines = ['﻿' + hb('sync-indexes', true, '2026-08-21T06:00:00.000Z')];
    expect(statusOf(evaluateHeartbeats(lines, EXPECTED, NOW), 'sync-indexes').state).toBe('ok');
  });

  it("parses a real PS1-emitted line (ConvertTo-Json key order, 'o'-format 7-digit fractional ts)", () => {
    const lines = ['{"task":"sync-indexes","ok":true,"ts":"2026-08-21T06:00:00.4530005Z"}'];
    const row = statusOf(evaluateHeartbeats(lines, EXPECTED, NOW), 'sync-indexes');
    expect(row.state).toBe('ok');
    expect(row.lastSeen).toBe('2026-08-21T06:00:00.4530005Z');
  });

  it('ignores heartbeats for tasks not in the expected list', () => {
    const lines = [hb('some-other-task', true, '2026-08-21T06:00:00.000Z')];
    const res = evaluateHeartbeats(lines, EXPECTED, NOW);
    expect(res).toHaveLength(2);
    expect(res.every((r) => r.state === 'missing')).toBe(true);
  });

  it('returns one row per expected task in expected order', () => {
    const res = evaluateHeartbeats([], EXPECTED, NOW);
    expect(res.map((r) => r.task)).toEqual(['sync-indexes', 'corpus-health']);
  });
});

describe('parseExpectOverrides', () => {
  it('returns null (use defaults) when no --expect args are present', () => {
    expect(parseExpectOverrides([])).toBeNull();
  });

  it('parses repeated --expect name:hours into an expected list', () => {
    expect(parseExpectOverrides(['--expect', 'foo:12', '--expect', 'bar:48'])).toEqual([
      { task: 'foo', cadenceHours: 12 },
      { task: 'bar', cadenceHours: 48 },
    ]);
  });

  it('throws on malformed --expect values', () => {
    expect(() => parseExpectOverrides(['--expect', 'foo'])).toThrow();
    expect(() => parseExpectOverrides(['--expect', 'foo:nope'])).toThrow();
    expect(() => parseExpectOverrides(['--expect', ':12'])).toThrow();
    expect(() => parseExpectOverrides(['--expect'])).toThrow();
  });

  it('throws on unknown flags (a typo must not silently report defaults)', () => {
    expect(() => parseExpectOverrides(['--expct', 'foo:12'])).toThrow();
  });
});

describe('resolveExpectedTasks (durable installed-task registry)', () => {
  it('uses every task in the durable registry', () => {
    const { expected, explicit } = resolveExpectedTasks([], () => EXPECTED);
    expect(expected).toEqual(EXPECTED);
    expect(explicit).toBe(false);
  });

  it('an empty registry is the exit-0 fresh-install case', () => {
    const { expected, explicit } = resolveExpectedTasks([], () => []);
    expect(expected).toEqual([]);
    expect(explicit).toBe(false);
  });

  it('explicit --expect entries bypass even a broken registry loader', () => {
    const { expected, explicit } = resolveExpectedTasks(
      ['--expect', 'sync-indexes:24', '--expect', 'custom-task:12'],
      () => { throw new Error('must not load'); }
    );
    expect(expected).toEqual([
      { task: 'sync-indexes', cadenceHours: 24 },
      { task: 'custom-task', cadenceHours: 12 },
    ]);
    expect(explicit).toBe(true);
  });
});

describe('expected-tasks registry lifecycle', () => {
  it('persists installs and removes an expectation only on explicit unregister', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-expected-tasks-'));
    try {
      const registryPath = expectedTasksPath(home);
      expect(readExpectedTasks(registryPath)).toEqual([]);

      updateExpectedTask(registryPath, { task: 'sync-indexes', cadenceHours: 24 }, true);
      updateExpectedTask(registryPath, { task: 'corpus-health', cadenceHours: 168 }, true);
      expect(readExpectedTasks(registryPath)).toEqual([
        { task: 'corpus-health', cadenceHours: 168 },
        { task: 'sync-indexes', cadenceHours: 24 },
      ]);

      updateExpectedTask(registryPath, { task: 'sync-indexes', cadenceHours: 1 }, false);
      expect(readExpectedTasks(registryPath)).toEqual([
        { task: 'corpus-health', cadenceHours: 168 },
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('every present installer registers after task creation and unregisters only in -Uninstall', () => {
    // The public cut ships a SUBSET of these installers (install-sync-task.ps1 is
    // operator-local — its runner drives the excluded sync:indexes script), so absent
    // files are skipped rather than ENOENT-failing the shipped test suite. The ≥1
    // floor keeps the test from passing vacuously on a tree with no installers at
    // all; the dev repo always carries both, so both are asserted there.
    const installers = [
      ['install-sync-task.ps1', 'sync-indexes', 24],
      ['install-corpus-health-task.ps1', 'corpus-health', 168],
    ] as const;
    let present = 0;
    for (const [file, task, cadence] of installers) {
      const installerPath = path.join(process.cwd(), 'scripts', 'ops', file);
      if (!fs.existsSync(installerPath)) continue;
      present++;
      const source = fs.readFileSync(installerPath, 'utf8');
      const uninstallBlock = source.match(/if \(\$Uninstall\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
      expect(uninstallBlock).toContain(`& node $ExpectedTasksHelper unregister ${task}`);
      expect(source.lastIndexOf('Register-ScheduledTask -TaskName')).toBeLessThan(
        source.indexOf(`& node $ExpectedTasksHelper register ${task} ${cadence}`)
      );
    }
    expect(present).toBeGreaterThan(0);
  });
});

describe('heartbeats CLI installed-task registry', () => {
  it('exits nonzero when an installed task has never heartbeated', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-heartbeats-'));
    try {
      const metricsDir = path.join(home, '.kopeng', 'metrics');
      fs.mkdirSync(metricsDir, { recursive: true });
      fs.writeFileSync(
        path.join(metricsDir, 'expected-tasks.json'),
        JSON.stringify([{ task: 'sync-indexes', cadenceHours: 24 }]),
        'utf8'
      );

      const result = spawnSync(
        process.execPath,
        [
          path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
          path.join(process.cwd(), 'scripts', 'ops', 'heartbeats-report.ts'),
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, HOME: home, USERPROFILE: home },
          encoding: 'utf8',
          timeout: 30_000,
        }
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/sync-indexes.*MISSING/i);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
