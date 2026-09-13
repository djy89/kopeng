import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '../fixtures/test-helpers.js';
import { DreamQueries } from '../../src/database/dream-queries.js';
import { PROMOTION_CARRIER_REASON } from '../../src/types/types.js';

describe('getLastCompletedDream ignores promotion carrier rows', () => {
  // Since T76 (F-5) the exclusion is driven by the is_carrier COLUMN, not by
  // matching the reason string — the reason here is just realistic fixture text.
  it('returns null when only carrier rows exist', async () => {
    const dreams = new DreamQueries(createTestDatabase().db);
    const d = await dreams.createDream({
      operator_id: 'default', scope: null, mode: 'whole_corpus',
      trigger_source: 'scheduled', reason: PROMOTION_CARRIER_REASON, is_carrier: true,
    });
    await dreams.updateDream(d.id, {
      status: 'completed', completed_at: new Date().toISOString(),
    });

    const last = await dreams.getLastCompletedDream('default', null, 'whole_corpus');
    expect(last).toBeNull();
  });

  it('still returns a real completed sweep', async () => {
    const dreams = new DreamQueries(createTestDatabase().db);
    const d = await dreams.createDream({
      operator_id: 'default', scope: null, mode: 'whole_corpus',
      trigger_source: 'scheduled', reason: 'fire', window_key: '2026-W33#whole#a0',
    });
    await dreams.updateDream(d.id, {
      status: 'completed', completed_at: new Date().toISOString(),
    });

    const last = await dreams.getLastCompletedDream('default', null, 'whole_corpus');
    expect(last?.id).toBe(d.id);
  });
});
