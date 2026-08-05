export const storeMemoryTool = {
  definition: {
    name: 'store_memory',
    description: 'Store a new memory in the persistent memory system. Automatically generates embeddings for semantic search. Deduplicates by content hash.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The memory content to store' },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'Memory type: user (preferences/role), feedback (corrections), project (ongoing work), reference (external pointers)',
          default: 'reference',
        },
        scope: {
          type: 'string',
          description: 'Scope: "global" or "project:<name>" or "client:<name>"',
          default: 'global',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization and filtering',
          default: [],
        },
        metadata: {
          type: 'object',
          description: 'Additional metadata as key-value pairs',
          default: {},
        },
        confidence: {
          type: 'number',
          description: 'Belief strength 0-1. Omitted = server default 0.9 (decays slowly, consolidation-visible). Pass 1.0 explicitly for permanent operator truths — the Hard Anchor tier, immune to decay and auto-archival. Set lower (e.g. 0.7) for journal-style reflections that should fade in ranking unless recalled.',
          minimum: 0,
          maximum: 1,
        },
      },
      required: ['content'],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const response = await fetch(`${apiUrl}/api/memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Mutating endpoint — admin-key gated when the server has ADMIN_API_KEY set.
        ...(process.env.ADMIN_API_KEY ? { 'x-api-key': process.env.ADMIN_API_KEY } : {}),
      },
      body: JSON.stringify({
        content: args.content,
        type: args.type || 'reference',
        scope: args.scope || 'global',
        tags: args.tags || [],
        metadata: args.metadata || {},
        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
        // The stdio MCP server is shared by multiple clients (Claude Code, Codex,
        // …) and cannot reliably know which one is calling — record neutral MCP
        // provenance rather than a guessed client or a machine identifier.
        source: 'mcp',
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to store memory: ${response.status} ${err}`);
    }

    const result = await response.json() as { data: { id: number; type: string; scope: string; summary: string; content: string }; meta?: { deduplicated: boolean } };
    const data = result.data;
    const dedup = result.meta?.deduplicated ? ' (deduplicated — already exists)' : '';
    return {
      content: [{
        type: 'text' as const,
        text: `Memory stored (ID: ${data.id})${dedup}\nType: ${data.type} | Scope: ${data.scope}\nSummary: ${data.summary || data.content.slice(0, 100)}`,
      }],
    };
  },
};
