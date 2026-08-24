import { describe, it, expect, vi, afterEach } from 'vitest';
import { updateMemoryTool } from '../../src/tools/update-memory.js';

afterEach(() => vi.unstubAllGlobals());

describe('update_memory confidence passthrough', () => {
  it('declares confidence in its input schema', () => {
    const props = updateMemoryTool.definition.inputSchema.properties as Record<string, unknown>;
    expect(props.confidence).toBeDefined();
  });

  it('forwards confidence in the PUT body', async () => {
    let sent: any = null;
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return { ok: true, json: async () => ({ data: { id: 1, confidence: 1.0 } }) };
    });

    await updateMemoryTool.handler({ id: 1, confidence: 1.0 }, 'http://127.0.0.1:3200');
    expect(sent.confidence).toBe(1.0);
  });

  it('forwards confidence: 0 — a future truthiness check must not silently drop the operator demoting a memory to zero', async () => {
    let sent: any = null;
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return { ok: true, json: async () => ({ data: { id: 1, confidence: 0 } }) };
    });

    await updateMemoryTool.handler({ id: 1, confidence: 0 }, 'http://127.0.0.1:3200');
    expect(sent.confidence).toBe(0);
  });

  it('omits confidence when not supplied', async () => {
    let sent: any = null;
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return { ok: true, json: async () => ({ data: { id: 1 } }) };
    });

    await updateMemoryTool.handler({ id: 1, content: 'x' }, 'http://127.0.0.1:3200');
    expect('confidence' in sent).toBe(false);
  });
});
