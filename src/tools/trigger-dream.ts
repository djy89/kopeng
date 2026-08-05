export const triggerDreamTool = {
  definition: {
    name: 'trigger_dream',
    description: 'Manually trigger a dream (memory-consolidation) pass over recent memories. Phase 0 emits an empty diff and records the pass; later phases propose dedup/merge/decay changes for review. Use `dry_run` to compute + log without writing. Set `mode: "whole_corpus"` for the heavy whole-corpus pass (every memory, not just the rotating window) — the activation/maintenance path. Dreaming also runs automatically while you are idle.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'Optional note recorded on the dream pass (e.g. why it was triggered).',
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, compute and log the pass without writing anything.',
        },
        window_key: {
          type: 'string',
          description: 'Optional explicit window key (defaults to the operator-local day). Lets a manual pass run again after the daily window already collapsed.',
        },
        mode: {
          type: 'string',
          enum: ['windowed', 'whole_corpus'],
          description: 'Pass type. Omit (or "windowed") for the nightly rotating window. "whole_corpus" runs the heavy pass over every active memory (id-segment reasoner gate) — pair with dry_run first to read the proposed counts (T17 activation runbook).',
        },
      },
      required: [],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const response = await fetch(`${apiUrl}/api/dreams/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // T27: mutating operator endpoint — admin-key gated when the server has ADMIN_API_KEY set
        ...(process.env.ADMIN_API_KEY ? { 'x-api-key': process.env.ADMIN_API_KEY } : {}),
      },
      body: JSON.stringify({
        reason: args.reason,
        dry_run: args.dry_run === true,
        window_key: args.window_key,
        mode: args.mode,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Dream trigger failed: ${response.status} ${err}`);
    }

    const result = await response.json() as {
      data: {
        status: string;
        dream_id: number | null;
        window_key: string;
        memories_examined: number;
        changes_proposed: number;
        duration_ms: number;
      };
    };

    const d = result.data;
    const lines = [
      `Dream pass ${d.status} in ${d.duration_ms}ms (window ${d.window_key}):`,
      `  Memories examined: ${d.memories_examined}`,
      `  Changes proposed: ${d.changes_proposed}`,
    ];
    if (d.dream_id !== null) lines.push(`  Dream id: ${d.dream_id}`);
    if (d.status === 'collapsed') lines[0] = `Dream window ${d.window_key} already ran — collapsed (id=${d.dream_id}).`;
    if (d.status === 'skipped') lines[0] = 'Dream pass skipped — consolidation lock held elsewhere.';
    if (d.status === 'dry_run') lines[0] = `Dream dry-run (window ${d.window_key}) — nothing written:`;

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  },
};
