export const traverseMemoryTool = {
  definition: {
    name: 'traverse_memory',
    description:
      'Traverse the memory graph to find entities and their connected memories. Use this to discover relationships between concepts, projects, technologies, and people across memories.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity: {
          type: 'string',
          description:
            'The entity name to start traversal from (e.g., "redis", "deployment", "auth")',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum traversal depth (default: 2)',
          default: 2,
        },
        limit: {
          type: 'number',
          description: 'Maximum memories to return (default: 20)',
          default: 20,
        },
      },
      required: ['entity'],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const response = await fetch(`${apiUrl}/api/memories/traverse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity: args.entity,
        max_depth: args.max_depth || 2,
        limit: args.limit || 20,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Graph traversal failed: ${response.status} ${err}`);
    }

    const result = (await response.json()) as {
      data: {
        entity: string;
        entityType: string;
        connectedMemoryIds: number[];
        relatedEntities: { name: string; type: string; relation: string }[];
        memories: {
          id: number;
          summary: string;
          type: string;
          scope: string;
        }[];
      };
    };

    const d = result.data;
    const entityInfo = `Entity: ${d.entity} (${d.entityType})`;
    const memoryList = d.memories?.length
      ? d.memories
          .map(
            (m) =>
              `  - [${m.id}] ${m.summary} (${m.type}/${m.scope})`
          )
          .join('\n')
      : '  (no connected memories)';
    const relatedList = d.relatedEntities?.length
      ? d.relatedEntities
          .map(
            (e) => `  - ${e.name} (${e.type}) via ${e.relation}`
          )
          .join('\n')
      : '  (no related entities)';

    return {
      content: [
        {
          type: 'text' as const,
          text: `${entityInfo}\n\nConnected memories (${d.connectedMemoryIds?.length || 0}):\n${memoryList}\n\nRelated entities:\n${relatedList}`,
        },
      ],
    };
  },
};
