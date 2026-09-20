import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '../fixtures/test-helpers.js';
import { DreamQueries } from '../../src/database/dream-queries.js';

describe('listAuditAfter', () => {
  it('pages the audit log by id ascending', async () => {
    const { db } = createTestDatabase();
    const dreams = new DreamQueries(db);
    const dream = await dreams.createDream({ mode: 'whole_corpus', trigger_source: 'scheduled', reason: 'test carrier', is_carrier: true });
    for (const cls of ['decay', 'reinforce', 'decay'] as const) {
      await dreams.appendAudit({ dream_id: dream.id, memory_id: 1, change_class: cls });
    }
    const page1 = await dreams.listAuditAfter({ limit: 2 });
    expect(page1.map(r => r.change_class)).toEqual(['decay', 'reinforce']);
    const page2 = await dreams.listAuditAfter({ after: page1[1].id, limit: 2 });
    expect(page2).toHaveLength(1);
    expect(page2[0].change_class).toBe('decay');
    expect(page2[0].id).toBeGreaterThan(page1[1].id);
    db.close();
  });
});
