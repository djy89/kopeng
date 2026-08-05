export const getContextTool = {
  definition: {
    name: 'get_context',
    description: 'Retrieve ephemeral context from Redis working memory. Use to check session state, multi-agent shared context, or temporary data. Returns null if key expired or not set.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'Context key to retrieve' },
        list_keys: { type: 'boolean', description: 'If true, list all context keys matching pattern instead of getting a value', default: false },
        pattern: { type: 'string', description: 'Key pattern for listing (e.g., "session:*"). Used with list_keys=true' },
      },
      required: [],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    if (args.list_keys) {
      const url = new URL(`${apiUrl}/api/context`);
      if (args.pattern) url.searchParams.set('pattern', args.pattern as string);

      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Failed to list context: ${response.status}`);

      const result = await response.json() as { data: { keys: string[] } };
      const keys = result.data.keys;
      return {
        content: [{
          type: 'text' as const,
          text: keys.length ? `Context keys (${keys.length}):\n${keys.map(k => `  - ${k}`).join('\n')}` : 'No context keys found',
        }],
      };
    }

    if (!args.key) {
      return { content: [{ type: 'text' as const, text: 'Error: "key" is required unless list_keys=true' }] };
    }

    const response = await fetch(`${apiUrl}/api/context/${encodeURIComponent(args.key as string)}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return { content: [{ type: 'text' as const, text: `Context key "${args.key}" not found (expired or never set)` }] };
      }
      throw new Error(`Failed to get context: ${response.status}`);
    }

    const result = await response.json() as { data: { key: string; value: string; ttl: number } };
    return {
      content: [{
        type: 'text' as const,
        text: `Context "${result.data.key}" (TTL: ${result.data.ttl}s):\n${result.data.value}`,
      }],
    };
  },
};
