export const triggerDiscoveryTool = {
  definition: {
    name: 'trigger_discovery',
    description: 'Manually trigger a discovery run to analyze recent tool-use observations and detect behavioral patterns. Auto-discovered patterns become low-confidence memories that surface in search results. Only needed for immediate analysis — discovery also runs automatically on a schedule.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_scope: {
          type: 'string',
          description: 'Optional project scope to limit discovery to (e.g. "project:kopeng"). If omitted, analyzes all project scopes.',
        },
      },
      required: [],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const response = await fetch(`${apiUrl}/api/discover`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Mutating endpoint — admin-key gated when the server has ADMIN_API_KEY set.
        ...(process.env.ADMIN_API_KEY ? { 'x-api-key': process.env.ADMIN_API_KEY } : {}),
      },
      body: JSON.stringify({
        project_scope: args.project_scope,
      }),
      signal: AbortSignal.timeout(60000), // Discovery can take longer
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Discovery trigger failed: ${response.status} ${err}`);
    }

    const result = await response.json() as {
      data: {
        run_id: number;
        project_scope: string;
        observations_analyzed: number;
        patterns_found: number;
        memories_created: number;
        memories_reinforced: number;
        duration_ms: number;
      };
    };

    const d = result.data;
    const lines = [
      `Discovery completed in ${d.duration_ms}ms:`,
      `  Observations analyzed: ${d.observations_analyzed}`,
      `  Patterns found: ${d.patterns_found}`,
      `  Memories created: ${d.memories_created}`,
      `  Memories reinforced: ${d.memories_reinforced}`,
    ];

    if (d.observations_analyzed === 0) {
      lines[0] = 'No unprocessed observations to analyze.';
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  },
};
