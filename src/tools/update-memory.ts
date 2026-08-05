export const updateMemoryTool = {
  definition: {
    name: 'update_memory',
    description: 'Update an existing memory. Re-generates embedding if content changes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Memory ID to update' },
        content: { type: 'string', description: 'New content (optional — only if changing)' },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'New type',
        },
        scope: { type: 'string', description: 'New scope' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'New tags (replaces existing)',
        },
        metadata: { type: 'object', description: 'New metadata (replaces existing)' },
      },
      required: ['id'],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const body: Record<string, unknown> = {};
    if (args.content !== undefined) body.content = args.content;
    if (args.type !== undefined) body.type = args.type;
    if (args.scope !== undefined) body.scope = args.scope;
    if (args.tags !== undefined) body.tags = args.tags;
    if (args.metadata !== undefined) body.metadata = args.metadata;

    const response = await fetch(`${apiUrl}/api/memories/${args.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        // Mutating endpoint — admin-key gated when the server has ADMIN_API_KEY set.
        ...(process.env.ADMIN_API_KEY ? { 'x-api-key': process.env.ADMIN_API_KEY } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to update memory: ${response.status} ${err}`);
    }

    const result = await response.json() as { meta?: { content_changed: boolean } };
    const contentChanged = result.meta?.content_changed ? ' (content changed, re-embedded)' : '';
    return {
      content: [{
        type: 'text' as const,
        text: `Memory #${args.id} updated${contentChanged}`,
      }],
    };
  },
};
