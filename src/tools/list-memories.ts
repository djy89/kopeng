export const listMemoriesTool = {
  definition: {
    name: 'list_memories',
    description: 'List memories with optional filtering by type, scope, or tags. Returns cursor-paginated results.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference', 'discovery'],
          description: 'Filter by memory type',
        },
        scope: {
          type: 'string',
          description: 'Filter by scope',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 20)',
          default: 20,
        },
        cursor: {
          type: 'number',
          description: 'Cursor for pagination (last memory ID from previous page)',
        },
        include_archived: {
          type: 'boolean',
          description: 'Include archived memories',
          default: false,
        },
      },
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const params = new URLSearchParams();
    if (args.type) params.set('type', args.type as string);
    if (args.scope) params.set('scope', args.scope as string);
    if (args.tags) params.set('tags', (args.tags as string[]).join(','));
    if (args.limit) params.set('limit', String(args.limit));
    if (args.cursor) params.set('cursor', String(args.cursor));
    if (args.include_archived) params.set('include_archived', 'true');

    const response = await fetch(`${apiUrl}/api/memories?${params}`, {
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`Failed to list memories: ${response.status}`);
    }

    const result = await response.json() as {
      data: Array<{
        id: number; content: string; type: string; scope: string; tags: string[];
        created_at: string; is_archived: number;
      }>;
      meta: { has_more: boolean; cursor?: number };
    };
    const data = result.data;

    if (data.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No memories found.' }] };
    }

    const lines = data.map(m => {
      const tags = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : '';
      const archived = m.is_archived ? ' (ARCHIVED)' : '';
      return `[ID:${m.id}] [${m.type}/${m.scope}]${tags}${archived}\n  ${m.content.slice(0, 150)}${m.content.length > 150 ? '...' : ''}`;
    });

    const meta = result.meta;
    const pagination = meta.has_more ? `\nMore available — use cursor: ${meta.cursor}` : '';

    return {
      content: [{ type: 'text' as const, text: lines.join('\n\n') + pagination }],
    };
  },
};
