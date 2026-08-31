import { describe, it, expect } from 'vitest';
import { isLegacyAnchor } from '../../scripts/ops/migrate-anchors-to-lock.js';
import {
  buildAnchorSelector,
  MIGRATABLE_TYPES,
  MIGRATE_ANCHORS_USAGE,
  migrateAnchorsCli,
} from '../../src/cli/migrate-anchors.js';

/**
 * WS7.4 B4: the pure selection predicate `migrate-anchors-to-lock.ts` uses to
 * pick candidates — exactly the set `legacy_anchor_count` (corpus-health)
 * reports and doctor warns about. No I/O, so no server needed.
 */
describe('isLegacyAnchor (WS7.4 B4 selection predicate)', () => {
  it('excludes a locked row, even at confidence 1.0 (is_locked IS the current anchor)', () => {
    expect(isLegacyAnchor({ is_locked: true, confidence: 1.0, metadata: null })).toBe(false);
    expect(isLegacyAnchor({ is_locked: 1, confidence: 1.0, metadata: null })).toBe(false);
  });

  it('includes an unlocked confidence>=1.0 row', () => {
    expect(isLegacyAnchor({ is_locked: false, confidence: 1.0, metadata: null })).toBe(true);
    expect(isLegacyAnchor({ is_locked: 0, confidence: 1.0, metadata: null })).toBe(true);
  });

  it('includes an unlocked pinned sub-1.0 row', () => {
    expect(isLegacyAnchor({ is_locked: 0, confidence: 0.5, metadata: '{"pinned":true}' })).toBe(true);
  });

  it('excludes an unlocked, unpinned, sub-1.0 row (0.9 is not an anchor at all)', () => {
    expect(isLegacyAnchor({ is_locked: 0, confidence: 0.9, metadata: null })).toBe(false);
  });

  it('excludes a row with malformed metadata (defensive parse — never throws, never pinned)', () => {
    expect(isLegacyAnchor({ is_locked: 0, confidence: 0.5, metadata: 'not json' })).toBe(false);
  });

  it('excludes a non-boolean pinned value (strict === true, matching isPinnedMetadata)', () => {
    expect(isLegacyAnchor({ is_locked: 0, confidence: 0.5, metadata: '{"pinned":"yes"}' })).toBe(false);
  });
});

/**
 * The `--type` narrowing (added while migrating the live corpus). Its reason for
 * existing is historical, not cosmetic: until 2026-07-10 the store default WAS
 * `1.0` (`input.confidence ?? 1.0`, changed to 0.9 by T22/T23), so on a corpus
 * with history a `confidence >= 1.0` row is not evidence that anyone CHOSE to
 * anchor it. Locking is the only one-way step in the migration — anchor triage
 * (D3) skips `is_locked` rows by design, so a row locked today leaves the triage
 * population permanently.
 */
describe('buildAnchorSelector (--type narrowing)', () => {
  const anchor = (type: string) => ({ is_locked: 0, confidence: 1.0, metadata: null, type });

  it('with no types, is exactly isLegacyAnchor', () => {
    const all = buildAnchorSelector();
    for (const t of MIGRATABLE_TYPES) expect(all(anchor(t))).toBe(true);
    expect(all({ is_locked: 0, confidence: 0.9, metadata: null, type: 'feedback' })).toBe(false);
    expect(buildAnchorSelector([])(anchor('project'))).toBe(true); // empty === unfiltered
  });

  it('keeps only the named types', () => {
    const s = buildAnchorSelector(['feedback', 'user']);
    expect(s(anchor('feedback'))).toBe(true);
    expect(s(anchor('user'))).toBe(true);
    expect(s(anchor('project'))).toBe(false);
    expect(s(anchor('reference'))).toBe(false);
    expect(s(anchor('discovery'))).toBe(false);
  });

  it('narrowing never WIDENS: a non-anchor of a named type is still excluded', () => {
    const s = buildAnchorSelector(['feedback']);
    expect(s({ is_locked: 0, confidence: 0.9, metadata: null, type: 'feedback' })).toBe(false);
    expect(s({ is_locked: true, confidence: 1.0, metadata: null, type: 'feedback' })).toBe(false);
  });

  it('still honors the pinned spelling within a named type', () => {
    const s = buildAnchorSelector(['user']);
    expect(s({ is_locked: 0, confidence: 0.5, metadata: '{"pinned":true}', type: 'user' })).toBe(true);
    expect(s({ is_locked: 0, confidence: 0.5, metadata: '{"pinned":true}', type: 'project' })).toBe(false);
  });
});

describe('migrateAnchorsCli --type parsing', () => {
  const io = () => {
    const errors: string[] = [];
    return { sink: { log: () => {}, error: (l: string) => errors.push(l) }, errors };
  };

  it('rejects an unknown memory type with exit 2 and does not run', async () => {
    const { sink, errors } = io();
    expect(await migrateAnchorsCli(['--type', 'bogus'], sink)).toBe(2);
    expect(errors.join('\n')).toContain('Unknown memory type: bogus');
  });

  it('rejects a missing --type value rather than swallowing the next flag', async () => {
    const { sink, errors } = io();
    expect(await migrateAnchorsCli(['--type', '--apply'], sink)).toBe(2);
    expect(errors.join('\n')).toContain('--type requires a value');
  });

  it('names the accepted types in its usage output', () => {
    for (const t of MIGRATABLE_TYPES) expect(MIGRATE_ANCHORS_USAGE).toContain(t);
  });
});
