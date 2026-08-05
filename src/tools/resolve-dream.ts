export const resolveDreamTool = {
  definition: {
    name: 'resolve_dream',
    description: 'Accept or reject a dream pass\'s queued change proposals. Accept applies actionable entries (snapshot to memory_revisions, archive, audit — reversible via the rollback API); reject leaves the memory store untouched. Pass entry_indices to resolve a subset (a partial resolution); omit it to resolve all pending entries.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dream_id: {
          type: 'number',
          description: 'Dream pass id (from list_pending_dreams)',
        },
        action: {
          type: 'string',
          enum: ['accept', 'reject'],
          description: 'accept = apply the proposals; reject = discard them, store untouched',
        },
        entry_indices: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional subset of diff entry indices (from get_dream_diff). Omit to resolve all pending entries.',
        },
      },
      required: ['dream_id', 'action'],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const response = await fetch(`${apiUrl}/api/dreams/${args.dream_id}/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // T27: mutating operator endpoint — admin-key gated when the server has ADMIN_API_KEY set
        ...(process.env.ADMIN_API_KEY ? { 'x-api-key': process.env.ADMIN_API_KEY } : {}),
      },
      body: JSON.stringify({
        action: args.action,
        entry_indices: args.entry_indices,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to resolve dream: ${response.status} ${err}`);
    }

    const result = await response.json() as {
      data: {
        dream_id: number;
        action: string;
        acceptance_status: string;
        applied: number;
        rejected: number;
        skipped: number;
        results: Array<{ index: number; outcome: string; archived_ids: number[]; detail?: string }>;
      };
    };
    const d = result.data;

    const lines = [
      `Dream ${d.dream_id} ${d.action}: ${d.applied} applied, ${d.rejected} rejected, ${d.skipped} skipped — now '${d.acceptance_status}'`,
    ];
    for (const r of d.results) {
      const archived = r.archived_ids.length > 0 ? ` (archived: ${r.archived_ids.join(', ')})` : '';
      const detail = r.detail ? ` — ${r.detail}` : '';
      lines.push(`  #${r.index}: ${r.outcome}${archived}${detail}`);
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  },
};
