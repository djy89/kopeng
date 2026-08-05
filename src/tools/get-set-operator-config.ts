/**
 * Operator-config tools (D1.3). The auto_accept_* flags ship OFF and govern the
 * dream auto-apply path — flipping them is an operator decision at GATE 1, not
 * something an agent should do unprompted.
 */

function renderConfig(cfg: Record<string, unknown>): string {
  return [
    `Operator: ${cfg.operator_id}`,
    `  timezone: ${cfg.timezone ?? '(default)'}`,
    `  quiet hours: ${cfg.quiet_hours_start ?? '(default)'} – ${cfg.quiet_hours_end ?? '(default)'}`,
    `  idle_minutes: ${cfg.idle_minutes}`,
    `  dream_cadence: ${cfg.dream_cadence ?? '(default)'}`,
    `  auto_accept_exact_dup: ${cfg.auto_accept_exact_dup}`,
    `  auto_accept_decay: ${cfg.auto_accept_decay}`,
    `  reasoner_provider: ${cfg.reasoner_provider ?? '(none)'}`,
    `  updated_at: ${cfg.updated_at}`,
  ].join('\n');
}

export const getOperatorConfigTool = {
  definition: {
    name: 'get_operator_config',
    description: 'Show the operator configuration for the dreaming layer: timezone, quiet hours, idle threshold, dream cadence, reasoner provider, and the auto_accept_* flags that gate dream auto-apply.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },

  handler: async (_args: Record<string, unknown>, apiUrl: string) => {
    const response = await fetch(`${apiUrl}/api/operator-config`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to get operator config: ${response.status} ${err}`);
    }
    const result = await response.json() as { data: Record<string, unknown> };
    return { content: [{ type: 'text' as const, text: renderConfig(result.data) }] };
  },
};

export const setOperatorConfigTool = {
  definition: {
    name: 'set_operator_config',
    description: 'Patch the operator configuration for the dreaming layer. Only the provided fields change — send a PARTIAL patch, never a full read-merge-write (the server merges the `config` blob for you). The auto_accept_* flags enable autonomous dream apply — flip them only on an explicit operator decision (GATE 1).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA timezone (e.g. America/New_York) used for quiet hours and the dream window day',
        },
        quiet_hours_start: {
          type: 'string',
          description: 'Quiet-hours start, HH:MM (24h)',
        },
        quiet_hours_end: {
          type: 'string',
          description: 'Quiet-hours end, HH:MM (24h)',
        },
        idle_minutes: {
          type: 'number',
          description: 'Minutes of operator inactivity before a dream may fire',
        },
        dream_cadence: {
          type: 'string',
          description: 'Dream cadence label (informational)',
        },
        auto_accept_exact_dup: {
          type: 'boolean',
          description: 'Auto-apply exact-duplicate collapses (operator decision — GATE 1)',
        },
        auto_accept_decay: {
          type: 'boolean',
          description: 'Auto-apply decay archive proposals (operator decision — GATE 1)',
        },
        reasoner_provider: {
          type: 'string',
          description: 'Reasoner provider id for Phase 2 (e.g. ollama:llama3)',
        },
        config: {
          type: 'object',
          description: 'Partial patch for the operator_config `config` JSON blob (e.g. dream_reasoner settings, dream_whole_corpus_cadence). The server MERGES these keys into the stored blob — send only the keys you want to change; an explicit null value DELETES that key. Do NOT read-merge-write the full blob (it would race engine cursor writes like dream_window_cursor).',
          additionalProperties: true,
        },
      },
      required: [],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const response = await fetch(`${apiUrl}/api/operator-config`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        // T27: mutating operator endpoint — admin-key gated when the server has ADMIN_API_KEY set
        ...(process.env.ADMIN_API_KEY ? { 'x-api-key': process.env.ADMIN_API_KEY } : {}),
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to update operator config: ${response.status} ${err}`);
    }
    const result = await response.json() as { data: Record<string, unknown> };
    return {
      content: [{ type: 'text' as const, text: `Updated.\n${renderConfig(result.data)}` }],
    };
  },
};
