export const archiveMemoryTool = {
  definition: {
    name: 'archive_memory',
    description: 'Archive or unarchive a memory. Archived memories are excluded from search by default but not deleted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Memory ID' },
        archive: {
          type: 'boolean',
          description: 'true to archive, false to unarchive',
          default: true,
        },
      },
      required: ['id'],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const archive = args.archive !== undefined ? args.archive : true;

    const response = await fetch(`${apiUrl}/api/memories/${args.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        // Mutating endpoint — admin-key gated when the server has ADMIN_API_KEY set.
        ...(process.env.ADMIN_API_KEY ? { 'x-api-key': process.env.ADMIN_API_KEY } : {}),
      },
      body: JSON.stringify({ archive }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to ${archive ? 'archive' : 'unarchive'} memory: ${response.status} ${err}`);
    }

    return {
      content: [{
        type: 'text' as const,
        text: `Memory #${args.id} ${archive ? 'archived' : 'unarchived'}.`,
      }],
    };
  },
};
