/**
 * NH1 — MCP tool contract suite. The tool handlers in src/tools/** are pure HTTP
 * clients over the REST API (excluded from coverage), so this asserts the glue
 * that isn't covered elsewhere: request mapping (URL / method / body), response
 * formatting, and error responses. fetch is mocked — no server, no network.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { storeMemoryTool } from '../../src/tools/store-memory.js';
import { searchMemoriesTool } from '../../src/tools/search-memories.js';
import { getMemoryTool } from '../../src/tools/get-memory.js';

const API = 'http://localhost:3200';

type FetchArgs = [string, { method?: string; body?: string } | undefined];

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MCP tool contracts', () => {
  describe('store_memory', () => {
    it('POSTs /api/memories with the mapped body and formats the result', async () => {
      const fetchMock = stubFetch(200, { data: { id: 42, type: 'project', scope: 'global', summary: 'sum', content: 'c' } });
      const out = await storeMemoryTool.handler({ content: 'hello', type: 'project' }, API);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as unknown as FetchArgs;
      expect(url).toBe(`${API}/api/memories`);
      expect(init?.method).toBe('POST');
      const sent = JSON.parse(init!.body as string);
      expect(sent.content).toBe('hello');
      expect(sent.type).toBe('project');
      expect(sent.scope).toBe('global'); // default applied
      expect(sent.source).toBe('mcp'); // neutral MCP provenance — the shared stdio server can't know the client
      expect(sent.created_by).toBeUndefined(); // no machine identifier recorded
      expect(out.content[0].text).toContain('ID: 42');
    });

    it('surfaces the deduplicated note from meta', async () => {
      stubFetch(200, { data: { id: 1, type: 'reference', scope: 'global', summary: '', content: 'x' }, meta: { deduplicated: true } });
      const out = await storeMemoryTool.handler({ content: 'x' }, API);
      expect(out.content[0].text).toContain('deduplicated');
    });

    it('throws on a non-ok response', async () => {
      stubFetch(500, 'boom');
      await expect(storeMemoryTool.handler({ content: 'x' }, API)).rejects.toThrow(/Failed to store memory: 500/);
    });
  });

  describe('search_memories', () => {
    it('POSTs /api/memories/search applying mode/limit defaults and formats results', async () => {
      const fetchMock = stubFetch(200, {
        data: [{ memory: { id: 7, content: 'ctx', type: 'project', scope: 'global', tags: ['a'], created_at: '' }, score: 0.9, match_type: 'hybrid' }],
        meta: { total: 1, duration_ms: 5, reranked: false },
      });
      const out = await searchMemoriesTool.handler({ query: 'find' }, API);

      const [url, init] = fetchMock.mock.calls[0] as unknown as FetchArgs;
      expect(url).toBe(`${API}/api/memories/search`);
      const sent = JSON.parse(init!.body as string);
      expect(sent.query).toBe('find');
      expect(sent.mode).toBe('hybrid'); // default
      expect(sent.limit).toBe(10);      // default
      expect(out.content[0].text).toContain('[ID:7]');
    });

    it('formats an empty result set', async () => {
      stubFetch(200, { data: [], meta: { total: 0, duration_ms: 1, reranked: false } });
      const out = await searchMemoriesTool.handler({ query: 'none' }, API);
      expect(out.content[0].text).toBe('No matching memories found.');
    });
  });

  describe('get_memory', () => {
    it('GETs /api/memories/:id and formats the memory', async () => {
      const fetchMock = stubFetch(200, { data: { id: 9, content: 'body', type: 'reference', scope: 'global', tags: ['t'], metadata: '{}', created_at: 'c', updated_at: 'u' } });
      const out = await getMemoryTool.handler({ id: 9 }, API);

      const [url, init] = fetchMock.mock.calls[0] as unknown as FetchArgs;
      expect(url).toBe(`${API}/api/memories/9`);
      expect(init?.method).toBeUndefined(); // GET (default)
      expect(out.content[0].text).toContain('Memory #9');
      expect(out.content[0].text).toContain('body');
    });

    it('returns a friendly message on 404 (not a throw)', async () => {
      stubFetch(404, { error: 'not found' });
      const out = await getMemoryTool.handler({ id: 123 }, API);
      expect(out.content[0].text).toBe('Memory 123 not found.');
    });

    it('throws on other non-ok statuses', async () => {
      stubFetch(500, 'err');
      await expect(getMemoryTool.handler({ id: 1 }, API)).rejects.toThrow(/Failed to get memory: 500/);
    });
  });
});
