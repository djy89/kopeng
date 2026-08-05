interface DiffMember {
  id: number;
  missing?: boolean;
  type?: string;
  scope?: string;
  confidence?: number;
  observation_count?: number | null;
  last_seen?: string | null;
  is_archived?: boolean;
  tags?: string[];
  excerpt?: string;
  evidence_count?: number;
}

interface DiffEntry {
  index: number;
  change_class: string;
  tier: string;
  resolution: string;
  resolved_at: string | null;
  rationale: string;
  proposal: unknown;
  confidence_delta: number | null;
  members: DiffMember[];
  impact: { if_accepted: string; if_rejected: string; reversible: boolean };
}

export const getDreamDiffTool = {
  definition: {
    name: 'get_dream_diff',
    description: 'Show the human-readable diff of one dream pass: per-entry rationale, evidence cited, confidence deltas, and the affected memories. Entry indices feed resolve_dream for accept/reject (or partial via a subset of indices).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dream_id: {
          type: 'number',
          description: 'Dream pass id (from list_pending_dreams or trigger_dream)',
        },
      },
      required: ['dream_id'],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const response = await fetch(`${apiUrl}/api/dreams/${args.dream_id}/diff`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to get dream diff: ${response.status} ${err}`);
    }

    const result = await response.json() as {
      data: {
        dream: {
          id: number; window_key: string | null; scope: string | null; mode: string;
          status: string; acceptance_status: string; started_at: string;
          memories_examined: number; changes_auto_applied: number; changes_queued: number;
        };
        entries: DiffEntry[];
      };
    };
    const { dream, entries } = result.data;

    const header =
      `Dream ${dream.id} (window ${dream.window_key ?? 'n/a'}, ${dream.started_at})\n` +
      `Status: ${dream.status} / ${dream.acceptance_status} · examined ${dream.memories_examined}` +
      ` · ${dream.changes_auto_applied} auto-applied · ${dream.changes_queued} queued`;

    if (entries.length === 0) {
      return { content: [{ type: 'text' as const, text: `${header}\n\nEmpty diff — nothing proposed.` }] };
    }

    const blocks = entries.map(e => {
      const lines = [
        `#${e.index} [${e.change_class} | ${e.tier} | ${e.resolution}]`,
        `  ${e.rationale}`,
        `  If accepted: ${e.impact.if_accepted}`,
        `  If rejected: ${e.impact.if_rejected}`,
      ];
      if (e.impact.reversible) {
        lines.push('  (Accepting is reversible — snapshotted, restorable via rollback.)');
      }
      if (e.confidence_delta !== null) {
        lines.push(`  Δconfidence (kept vs strongest archived): ${e.confidence_delta >= 0 ? '+' : ''}${e.confidence_delta.toFixed(2)}`);
      }
      for (const m of e.members) {
        if (m.missing) {
          lines.push(`  - #${m.id} (no longer exists)`);
          continue;
        }
        const evidence = m.evidence_count ? `, ${m.evidence_count} evidence entr${m.evidence_count === 1 ? 'y' : 'ies'}` : '';
        lines.push(
          `  - #${m.id} [${m.type}/${m.scope}] conf ${m.confidence?.toFixed(2)}, ${m.observation_count ?? 1} obs${evidence}${m.is_archived ? ' (ARCHIVED)' : ''}`,
          `      ${m.excerpt}`,
        );
      }
      return lines.join('\n');
    });

    return {
      content: [{ type: 'text' as const, text: `${header}\n\n${blocks.join('\n\n')}` }],
    };
  },
};
