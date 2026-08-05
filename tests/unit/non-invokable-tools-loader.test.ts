/**
 * T35 — non-invokable tool-key loader (publish blocker fix).
 * The operator-specific NON_INVOKABLE_TOOL_KEYS were hardcoded in
 * scripts/metric-surfacing.ts (which ships in the public cut) and leaked a
 * personal project name into the export forbidden-token scan. The keys now
 * live in an untracked local file — ~/.kopeng/non-invokable-tools.json, an
 * object map of key → rationale — merged over an EMPTY shipped default.
 * Fail-soft throughout: a missing or malformed file must never stop the
 * metric from running.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadNonInvokableToolKeys, DEFAULT_NON_INVOKABLE_TOOL_KEYS,
} from '../../scripts/metric-surfacing.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nitk-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('loadNonInvokableToolKeys (T35)', () => {
  it('ships with an EMPTY default — no operator keys in tracked source', () => {
    expect(DEFAULT_NON_INVOKABLE_TOOL_KEYS).toHaveLength(0);
  });

  it('reads an object map and returns its keys (rationale values ignored)', () => {
    const p = join(dir, 'keys.json');
    writeFileSync(p, JSON.stringify({ 'my-cli': 'a CLI, not a server', 'my-task': 'scheduled automation' }));
    const keys = loadNonInvokableToolKeys(p);
    expect(keys.has('my-cli')).toBe(true);
    expect(keys.has('my-task')).toBe(true);
    expect(keys.size).toBe(2);
  });

  it('missing file → the empty default, no throw', () => {
    const keys = loadNonInvokableToolKeys(join(dir, 'does-not-exist.json'));
    expect(keys.size).toBe(0);
  });

  it('malformed JSON → the empty default, no throw (metric must still run)', () => {
    const p = join(dir, 'broken.json');
    writeFileSync(p, '{ not json');
    expect(loadNonInvokableToolKeys(p).size).toBe(0);
  });

  it('an array (wrong shape) → the empty default — the contract is an object map', () => {
    const p = join(dir, 'array.json');
    writeFileSync(p, JSON.stringify(['my-cli', 'my-task']));
    expect(loadNonInvokableToolKeys(p).size).toBe(0);
  });

  it('KOPENG_NON_INVOKABLE_TOOLS env var overrides the default path', () => {
    const p = join(dir, 'env-keys.json');
    writeFileSync(p, JSON.stringify({ 'env-key': 'via env override' }));
    const prev = process.env.KOPENG_NON_INVOKABLE_TOOLS;
    process.env.KOPENG_NON_INVOKABLE_TOOLS = p;
    try {
      expect(loadNonInvokableToolKeys().has('env-key')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.KOPENG_NON_INVOKABLE_TOOLS;
      else process.env.KOPENG_NON_INVOKABLE_TOOLS = prev;
    }
  });

  it('an explicit filePath argument wins over the env var', () => {
    const envP = join(dir, 'env.json');
    const argP = join(dir, 'arg.json');
    writeFileSync(envP, JSON.stringify({ 'env-key': 'x' }));
    writeFileSync(argP, JSON.stringify({ 'arg-key': 'y' }));
    const prev = process.env.KOPENG_NON_INVOKABLE_TOOLS;
    process.env.KOPENG_NON_INVOKABLE_TOOLS = envP;
    try {
      const keys = loadNonInvokableToolKeys(argP);
      expect(keys.has('arg-key')).toBe(true);
      expect(keys.has('env-key')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.KOPENG_NON_INVOKABLE_TOOLS;
      else process.env.KOPENG_NON_INVOKABLE_TOOLS = prev;
    }
  });
});
