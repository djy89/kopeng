export const evalRetrievalTool = {
  definition: {
    name: 'eval_retrieval',
    description: 'Run an ad-hoc retrieval evaluation. Searches for a query and computes precision/recall against expected memory IDs. Use this to test whether the search pipeline is returning relevant results.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The search query to evaluate' },
        expected_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'List of memory IDs that should appear in results',
        },
        mode: {
          type: 'string',
          enum: ['hybrid', 'semantic', 'keyword'],
          description: 'Search mode (default: hybrid)',
          default: 'hybrid',
        },
        rerank: {
          type: 'boolean',
          description: 'Enable reranking (default: true)',
          default: true,
        },
        k: {
          type: 'number',
          description: 'Number of results to evaluate at (default: 5)',
          default: 5,
        },
      },
      required: ['query', 'expected_ids'],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const query = args.query as string;
    const expectedIds = args.expected_ids as number[];
    const mode = (args.mode as string) || 'hybrid';
    const shouldRerank = args.rerank !== false;
    const k = (args.k as number) || 5;

    const response = await fetch(`${apiUrl}/api/memories/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        mode,
        rerank: shouldRerank,
        rerank_candidates: 20,
        limit: k,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Search failed: ${response.status} ${err}`);
    }

    const result = await response.json() as {
      data: Array<{
        memory: { id: number; content: string; type: string };
        score: number;
        rerank_score?: number;
      }>;
      meta: { reranked: boolean; duration_ms: number };
    };

    const retrievedIds = result.data.map(r => r.memory.id);
    const expectedSet = new Set(expectedIds);

    // Precision@K: how many retrieved are relevant
    const relevantRetrieved = retrievedIds.filter(id => expectedSet.has(id));
    const precision = retrievedIds.length > 0 ? relevantRetrieved.length / retrievedIds.length : 0;

    // Recall@K: how many expected were retrieved
    const recall = expectedIds.length > 0 ? relevantRetrieved.length / expectedIds.length : 0;

    // MRR: reciprocal rank of first relevant result
    let mrr = 0;
    for (let i = 0; i < retrievedIds.length; i++) {
      if (expectedSet.has(retrievedIds[i])) {
        mrr = 1 / (i + 1);
        break;
      }
    }

    const lines = [
      `Query: "${query}"`,
      `Mode: ${mode} | Reranked: ${result.meta.reranked} | K: ${k}`,
      ``,
      `Precision@${k}: ${precision.toFixed(3)} (${relevantRetrieved.length}/${retrievedIds.length} relevant)`,
      `Recall@${k}: ${recall.toFixed(3)} (${relevantRetrieved.length}/${expectedIds.length} found)`,
      `MRR: ${mrr.toFixed(3)}`,
      ``,
      `Retrieved:`,
      ...result.data.map((r, i) => {
        const relevant = expectedSet.has(r.memory.id) ? ' [RELEVANT]' : '';
        const scoreStr = r.rerank_score !== undefined
          ? `rerank=${r.rerank_score.toFixed(3)}`
          : `score=${r.score.toFixed(3)}`;
        return `  ${i + 1}. [ID:${r.memory.id}] (${scoreStr})${relevant} ${r.memory.content.slice(0, 100)}...`;
      }),
      ``,
      `Expected IDs: ${expectedIds.join(', ')}`,
      `Duration: ${result.meta.duration_ms}ms`,
    ];

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  },
};
