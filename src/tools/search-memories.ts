export const searchMemoriesTool = {
  definition: {
    name: 'search_memories',
    description: 'Search memories using hybrid semantic + keyword search with optional cross-encoder reranking. Returns the most relevant memories ranked by combined score. Use this to find past context, decisions, lessons learned, or any previously stored knowledge.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query — can be natural language or keywords' },
        mode: {
          type: 'string',
          enum: ['hybrid', 'semantic', 'keyword'],
          description: 'Search mode: hybrid (default, best results), semantic (meaning-based), keyword (exact match)',
          default: 'hybrid',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference', 'discovery'],
          description: 'Filter by memory type',
        },
        scope: {
          type: 'string',
          description: 'Filter by scope (e.g. "global", "project:kopeng")',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10)',
          default: 10,
        },
        rerank: {
          type: 'boolean',
          description: 'Enable cross-encoder reranking for better relevance (default true)',
          default: true,
        },
      },
      required: ['query'],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const response = await fetch(`${apiUrl}/api/memories/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: args.query,
        mode: args.mode || 'hybrid',
        type: args.type,
        scope: args.scope,
        tags: args.tags,
        limit: args.limit || 10,
        rerank: args.rerank,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Search failed: ${response.status} ${err}`);
    }

    const result = await response.json() as {
      data: Array<{
        memory: { id: number; content: string; type: string; scope: string; tags: string[]; created_at: string };
        score: number;
        rerank_score?: number;
        match_type: string;
      }>;
      meta: { total: number; duration_ms: number; reranked: boolean };
    };
    const data = result.data;

    if (data.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No matching memories found.' }],
      };
    }

    const lines = data.map((r, i) => {
      const m = r.memory;
      const tags = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : '';
      const scoreStr = r.rerank_score !== undefined
        ? `${r.rerank_score.toFixed(3)} rerank / ${r.score.toFixed(3)} base`
        : r.score.toFixed(3);
      return `${i + 1}. [ID:${m.id}] (${scoreStr}) [${m.type}/${m.scope}]${tags}\n   ${m.content.slice(0, 300)}${m.content.length > 300 ? '...' : ''}`;
    });

    const meta = result.meta;
    const rerankLabel = meta.reranked ? ', reranked' : '';
    const footer = `\n--- ${data.length} of ${meta.total} results (${meta.duration_ms}ms${rerankLabel}) ---`;

    return {
      content: [{ type: 'text' as const, text: lines.join('\n\n') + footer }],
    };
  },
};
