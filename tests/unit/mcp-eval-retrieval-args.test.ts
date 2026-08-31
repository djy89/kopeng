import { describe, it, expect, vi, afterEach } from 'vitest';
import { evalRetrievalTool } from '../../src/tools/eval-retrieval.js';

afterEach(() => vi.unstubAllGlobals());

/**
 * `query` and `expected_ids` are both declared `required` in the inputSchema, but
 * nothing enforced that at runtime: the handler cast `args.expected_ids` and then
 * dereferenced `.length`, so omitting it threw
 * "Cannot read properties of undefined (reading 'length')" — an error that reads
 * like a broken tool rather than a malformed call. That message survived ~3 months
 * and several sessions as a documented "eval_retrieval is broken" belief, until
 * someone read the 40-line source. These tests pin the diagnostic messages, not
 * just the fact that something throws.
 */
describe('eval_retrieval argument validation', () => {
  const noFetch = () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('fetch must not be called when arguments are invalid');
    });
  };

  it('rejects a missing expected_ids by name, not with a TypeError', async () => {
    noFetch();
    await expect(
      evalRetrievalTool.handler({ query: 'anything' }, 'http://127.0.0.1:3200'),
    ).rejects.toThrow(/`expected_ids` is required/);
  });

  it('does not throw the historical undefined-deref message', async () => {
    noFetch();
    await expect(
      evalRetrievalTool.handler({ query: 'anything' }, 'http://127.0.0.1:3200'),
    ).rejects.not.toThrow(/Cannot read properties of undefined/);
  });

  it('rejects the plural `queries` shape by naming `query`', async () => {
    noFetch();
    await expect(
      evalRetrievalTool.handler({ queries: ['a'], expected_ids: [1] }, 'http://127.0.0.1:3200'),
    ).rejects.toThrow(/`query` is required/);
  });

  it.each([
    ['a non-array expected_ids', { query: 'a', expected_ids: 5 }],
    ['a non-numeric member', { query: 'a', expected_ids: [1, 'two'] }],
  ])('rejects %s', async (_label, args) => {
    noFetch();
    await expect(
      evalRetrievalTool.handler(args as Record<string, unknown>, 'http://127.0.0.1:3200'),
    ).rejects.toThrow(/`expected_ids` is required/);
  });

  it('rejects a whitespace-only query', async () => {
    noFetch();
    await expect(
      evalRetrievalTool.handler({ query: '   ', expected_ids: [1] }, 'http://127.0.0.1:3200'),
    ).rejects.toThrow(/`query` is required/);
  });

  // Negative control: the guards must not reject a well-formed call. Without this,
  // a guard that rejected everything would pass every test above.
  it('lets a valid call through to the API and scores it', async () => {
    let calledWith: any = null;
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      calledWith = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          data: [{ memory: { id: 42, content: 'hit', type: 'reference' }, score: 0.9 }],
          meta: { reranked: true, duration_ms: 1 },
        }),
      };
    });

    const res = await evalRetrievalTool.handler(
      { query: 'deploy steps', expected_ids: [42] },
      'http://127.0.0.1:3200',
    );

    expect(calledWith.query).toBe('deploy steps');
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('[RELEVANT]');
    expect(text).toContain('MRR: 1.000');
  });
});
