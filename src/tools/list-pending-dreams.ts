export const listPendingDreamsTool = {
  definition: {
    name: 'list_pending_dreams',
    description: 'List dream (memory-consolidation) passes with queued changes awaiting operator review. Use get_dream_diff to inspect a pass and resolve_dream to accept/reject its proposals.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Max dreams to return (default 20)',
          default: 20,
        },
      },
      required: [],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const params = new URLSearchParams();
    if (args.limit) params.set('limit', String(args.limit));

    const response = await fetch(`${apiUrl}/api/dreams/pending?${params}`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to list pending dreams: ${response.status} ${err}`);
    }

    const result = await response.json() as {
      data: Array<{
        id: number; window_key: string | null; scope: string | null; mode: string;
        trigger_source: string; acceptance_status: string; started_at: string;
        memories_examined: number; changes_auto_applied: number;
        pending_entries: number; entries_total: number;
      }>;
    };

    if (result.data.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No dreams awaiting review.' }] };
    }

    const lines = result.data.map(d =>
      `[Dream ${d.id}] window ${d.window_key ?? 'n/a'} (${d.trigger_source}, ${d.started_at})\n` +
      `  ${d.pending_entries}/${d.entries_total} entr${d.entries_total === 1 ? 'y' : 'ies'} pending` +
      ` · ${d.changes_auto_applied} auto-applied · ${d.memories_examined} memories examined · status: ${d.acceptance_status}`
    );

    return {
      content: [{ type: 'text' as const, text: lines.join('\n\n') }],
    };
  },
};
