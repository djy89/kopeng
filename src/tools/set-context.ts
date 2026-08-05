export const setContextTool = {
  definition: {
    name: 'set_context',
    description: 'Store ephemeral key-value context in Redis working memory. Use for session state, multi-agent shared context, or temporary data that should auto-expire. Default TTL: 1 hour.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'Context key (e.g., "current_task", "session:abc123")' },
        value: { type: 'string', description: 'Context value (string — JSON-encode objects)' },
        ttl: { type: 'number', description: 'Time-to-live in seconds (default: 3600 = 1 hour)' },
      },
      required: ['key', 'value'],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const response = await fetch(`${apiUrl}/api/context`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        // Mutating endpoint — admin-key gated when the server has ADMIN_API_KEY set.
        ...(process.env.ADMIN_API_KEY ? { 'x-api-key': process.env.ADMIN_API_KEY } : {}),
      },
      body: JSON.stringify({
        key: args.key,
        value: args.value,
        ttl: args.ttl,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to set context: ${response.status} ${err}`);
    }

    return {
      content: [{
        type: 'text' as const,
        text: `Context set: "${args.key}" (TTL: ${args.ttl || 3600}s)`,
      }],
    };
  },
};
