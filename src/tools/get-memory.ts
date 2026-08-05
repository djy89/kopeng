export const getMemoryTool = {
  definition: {
    name: 'get_memory',
    description: 'Get a specific memory by its ID. Returns full content, metadata, and tags.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Memory ID' },
      },
      required: ['id'],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const response = await fetch(`${apiUrl}/api/memories/${args.id}`, {
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return { content: [{ type: 'text' as const, text: `Memory ${args.id} not found.` }] };
      }
      throw new Error(`Failed to get memory: ${response.status}`);
    }

    const result = await response.json() as { data: { id: number; content: string; type: string; scope: string; tags: string[]; metadata: string; created_at: string; updated_at: string } };
    const m = result.data;
    const tags = m.tags?.length > 0 ? `Tags: ${m.tags.join(', ')}` : 'Tags: none';
    const meta = m.metadata && m.metadata !== '{}' ? `Metadata: ${m.metadata}` : '';

    return {
      content: [{
        type: 'text' as const,
        text: `Memory #${m.id}\nType: ${m.type} | Scope: ${m.scope} | ${tags}\nCreated: ${m.created_at} | Updated: ${m.updated_at}\n${meta ? meta + '\n' : ''}\n${m.content}`,
      }],
    };
  },
};
