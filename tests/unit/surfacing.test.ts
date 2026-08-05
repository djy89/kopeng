/**
 * Unit tests for src/surfacing/surface.ts (C1.2 / T12).
 *
 * Pure in-memory: no network, no live server, no embedder model.
 * The embedder is mocked to return deterministic unit vectors so
 * cosine similarity is fully predictable.
 *
 * Catalog memories are seeded directly into the in-memory SQLite store
 * using the same format the importer writes:
 *   content  = "Name: description"
 *   scope    = client:claude-tool | client:claude-skill | client:claude-convention | project:<name>
 *   type     = reference
 *   tags     = ['claude-index', '<kind>', ...]
 *   metadata = { external_key: "tool:<slug>", name: "<name>" }
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';
import type { MemoryQueries } from '../../src/database/queries.js';
import type { IVectorSearch } from '../../src/database/interfaces.js';
import type { VectorSearchResult } from '../../src/embeddings/index.js';
import { surface } from '../../src/surfacing/surface.js';

// ── Mock the embedder ──────────────────────────────────────────────────────
// We control the embedding so cosine similarities are deterministic.

let mockEmbedderReady = true;
const mockEmbed = vi.fn(async (_text: string): Promise<Float32Array> => new Float32Array(384).fill(0));

vi.mock('../../src/embeddings/embedder.js', () => ({
  embed: (...args: Parameters<typeof mockEmbed>) => mockEmbed(...args),
  isEmbedderReady: () => mockEmbedderReady,
}));

// ── Stub vector index ──────────────────────────────────────────────────────
// Keeps a simple map of id → embedding so search returns realistic scores.
// Tests that need semantic ranking register embeddings here.

interface StubEntry { id: number; vec: Float32Array }

function makeStubIndex(entries: StubEntry[] = []): IVectorSearch {
  const store = new Map<number, Float32Array>(entries.map(e => [e.id, e.vec]));

  function cosineSim(a: Float32Array, b: Float32Array): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  return {
    loadFromDatabase: async () => {},
    add: async (id, emb) => { store.set(id, emb); },
    remove: async (id) => { store.delete(id); },
    search: async (query, candidateIds, topK = 10): Promise<VectorSearchResult[]> => {
      const scope = candidateIds ? new Set(candidateIds) : null;
      const results: VectorSearchResult[] = [];
      for (const [id, vec] of store) {
        if (scope && !scope.has(id)) continue;
        results.push({ id, score: cosineSim(query, vec) });
      }
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, topK);
    },
    get isReady() { return true; },
    get size() { return store.size; },
  };
}

/** A zero-vector stub that always reports isReady = false. */
const notReadyIndex: IVectorSearch = {
  loadFromDatabase: async () => {},
  add: async () => {},
  remove: async () => {},
  search: async () => [],
  get isReady() { return false; },
  get size() { return 0; },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function meta(externalKey: string, name: string): string {
  return JSON.stringify({ external_key: externalKey, name });
}

/** Store a catalog memory, returning its id. */
async function addCatalogMemory(
  queries: MemoryQueries,
  opts: {
    scope: string;
    name: string;
    externalKey: string;
    description?: string;
    tags?: string[];
  },
): Promise<number> {
  const content = opts.description
    ? `${opts.name}: ${opts.description}`
    : opts.name;
  const result = await queries.store(
    createTestMemory({
      content,
      type: 'reference',
      scope: opts.scope,
      tags: opts.tags ?? ['claude-index'],
      metadata: meta(opts.externalKey, opts.name),
    }),
  );
  return result.id;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('surface()', () => {
  let queries: MemoryQueries;

  beforeEach(() => {
    ({ queries } = createTestDatabase());
    mockEmbedderReady = true;
    mockEmbed.mockReset();
    mockEmbed.mockImplementation(async () => new Float32Array(384).fill(0));
  });

  // (a) A skill-shaped prompt returns the matching skill with binding:'hard'
  //     and NOT unrelated ones.
  it('(a) returns the matching skill with binding "hard" and filters unrelated ones', async () => {
    // Seed: one skill whose FTS content matches the prompt, two unrelated skills.
    const handoffId = await addCatalogMemory(queries, {
      scope: 'client:claude-skill',
      name: 'Handoff',
      externalKey: 'skill:handoff',
      description: 'Generate handoff prompt and copy to clipboard',
      tags: ['claude-index', 'skill'],
    });
    await addCatalogMemory(queries, {
      scope: 'client:claude-skill',
      name: 'AWS Check',
      externalKey: 'skill:aws-check',
      description: 'Scan task for AWS service opportunities',
      tags: ['claude-index', 'skill'],
    });
    await addCatalogMemory(queries, {
      scope: 'client:claude-skill',
      name: 'Vault Note',
      externalKey: 'skill:vault-note',
      description: 'Create a markdown note with context-aware frontmatter',
      tags: ['claude-index', 'skill'],
    });

    // FTS-only (embedder returns zero vectors for all, so semantic contributes nothing).
    // The prompt has "handoff" which matches the Handoff skill content.
    const result = await surface(
      { queries, embeddingIndex: notReadyIndex },
      { prompt: 'I need to generate a handoff prompt for this session' },
    );

    // Handoff skill must appear
    expect(result.skills.some(s => s.key === 'skill:handoff')).toBe(true);
    // binding must be 'hard' for skills
    for (const s of result.skills) {
      expect(s.binding).toBe('hard');
    }
    // At most 2 skills (default cap)
    expect(result.skills.length).toBeLessThanOrEqual(2);
    // The matched skill must be the Handoff one (id check)
    const handoff = result.skills.find(s => s.key === 'skill:handoff');
    expect(handoff).toBeDefined();
    expect(handoff!.title).toBe('Handoff');
    // Unrelated skills should not dominate (if handoff is in, aws/vault are not both there when cap=2)
    // Since only FTS hits contribute, non-matching skills score 0 and are below the floor → excluded
    const keys = result.skills.map(s => s.key);
    expect(keys).toContain('skill:handoff');
    // The other two (aws-check, vault-note) shouldn't match "handoff" prompt at all
    expect(keys).not.toContain('skill:aws-check');
    expect(handoff!.content).toBe(`Handoff: Generate handoff prompt and copy to clipboard`);

    void handoffId; // referenced implicitly
  });

  // (b) Conventions come back with binding:'advisory'
  it('(b) conventions have binding "advisory"', async () => {
    await addCatalogMemory(queries, {
      scope: 'client:claude-convention',
      name: 'MEMSTACK',
      externalKey: 'convention:memstack',
      description: 'Persistent memory system MCP server at localhost:3200',
      tags: ['claude-index', 'convention'],
    });

    const result = await surface(
      { queries, embeddingIndex: notReadyIndex },
      { prompt: 'memstack memory store recall search' },
    );

    expect(result.conventions.length).toBeGreaterThan(0);
    for (const c of result.conventions) {
      expect(c.binding).toBe('advisory');
    }
    expect(result.conventions[0].key).toBe('convention:memstack');
  });

  // (c) Per-class caps enforced
  it('(c) enforces per-class caps', async () => {
    // Seed 5 skills all matching the prompt via FTS
    for (let i = 0; i < 5; i++) {
      await addCatalogMemory(queries, {
        scope: 'client:claude-skill',
        name: `Deploy Skill ${i}`,
        externalKey: `skill:deploy-skill-${i}`,
        description: `Deploy skill variant ${i} for deploying apps`,
        tags: ['claude-index', 'skill'],
      });
    }

    const result = await surface(
      { queries, embeddingIndex: notReadyIndex },
      { prompt: 'deploying apps using deploy skill' },
    );

    // Default cap = 2 skills
    expect(result.skills.length).toBeLessThanOrEqual(2);
  });

  it('(c) respects custom caps override', async () => {
    for (let i = 0; i < 5; i++) {
      await addCatalogMemory(queries, {
        scope: 'client:claude-tool',
        name: `Tool ${i}`,
        externalKey: `tool:tool-${i}`,
        description: `Some tool for memstack operations ${i}`,
        tags: ['claude-index', 'tool'],
      });
    }

    const result = await surface(
      { queries, embeddingIndex: notReadyIndex },
      { prompt: 'memstack operations tool', caps: { tools: 1 } },
    );

    expect(result.tools.length).toBeLessThanOrEqual(1);
  });

  // (d) Score floor drops weak matches
  it('(d) score floor drops weak/unrelated matches', async () => {
    // Seed tools whose content does NOT match the prompt at all
    await addCatalogMemory(queries, {
      scope: 'client:claude-tool',
      name: 'Email MCP',
      externalKey: 'tool:email-mcp',
      description: 'Query Office 365 emails',
      tags: ['claude-index', 'tool'],
    });
    await addCatalogMemory(queries, {
      scope: 'client:claude-tool',
      name: 'Asana MCP',
      externalKey: 'tool:asana-mcp',
      description: 'Task management in Asana',
      tags: ['claude-index', 'tool'],
    });

    // Prompt that has no lexical overlap with the tools above
    const result = await surface(
      { queries, embeddingIndex: notReadyIndex },
      { prompt: 'generate handoff skill' },
    );

    // The email/asana tools should NOT appear (no FTS match, embedder off → score=0 < floor)
    expect(result.tools).toHaveLength(0);
  });

  // (e) empty-relevant → empty arrays (never pad)
  it('(e) empty-relevant returns empty arrays', async () => {
    // No catalog memories at all
    const result = await surface(
      { queries, embeddingIndex: notReadyIndex },
      { prompt: 'do something with tools' },
    );
    expect(result.tools).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
    expect(result.conventions).toHaveLength(0);
  });

  it('(e) empty prompt returns empty arrays', async () => {
    await addCatalogMemory(queries, {
      scope: 'client:claude-skill',
      name: 'Handoff',
      externalKey: 'skill:handoff',
      description: 'Generate handoff',
      tags: ['claude-index', 'skill'],
    });
    // Empty prompt
    const result = await surface(
      { queries, embeddingIndex: notReadyIndex },
      { prompt: '   ' },
    );
    expect(result.tools).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
    expect(result.conventions).toHaveLength(0);
  });

  // Extra: per-project conventions are pulled when projectScope given
  it('pulls per-project conventions when projectScope is provided', async () => {
    await addCatalogMemory(queries, {
      scope: 'project:memstack',
      name: 'MEMSTACK dreaming',
      externalKey: 'convention:memstack',
      description: 'Autonomous nightly memory consolidation dreaming layer',
      tags: ['claude-index', 'convention'],
    });
    await addCatalogMemory(queries, {
      scope: 'client:claude-convention',
      name: 'Global convention',
      externalKey: 'convention:global-x',
      description: 'Some global convention dreaming layer operations',
      tags: ['claude-index', 'convention'],
    });

    const result = await surface(
      { queries, embeddingIndex: notReadyIndex },
      {
        prompt: 'dreaming layer memory consolidation',
        projectScope: 'project:memstack',
      },
    );

    // Both the global and per-project convention should appear (both match FTS)
    const keys = result.conventions.map(c => c.key);
    expect(keys).toContain('convention:memstack');
    // Both match; cap = 2, so both fit
    expect(keys).toContain('convention:global-x');
  });

  // Regression (real bug): surfacing must propose ONLY the curated
  // claude-index catalog, never arbitrary memories that share the scope. A
  // project-scoped memory without the claude-index tag must NOT surface as a
  // convention (otherwise project:<name> pulls in the whole project corpus and
  // the item gets an unstable per-call key, breaking the T13 acceptance metric).
  it('only surfaces claude-index catalog memories, not arbitrary scope members', async () => {
    // A curated per-project convention (tagged) ...
    await addCatalogMemory(queries, {
      scope: 'project:memstack',
      name: 'MEMSTACK convention',
      externalKey: 'convention:memstack',
      description: 'dreaming layer consolidation convention',
      tags: ['claude-index', 'convention'],
    });
    // ... and a regular project memory in the SAME scope that also matches FTS but
    // is NOT part of the catalog (no claude-index tag, no external_key).
    await queries.store(
      createTestMemory({
        content: 'A hot-file discovery about the dreaming layer consolidation engine',
        type: 'project',
        scope: 'project:memstack',
        tags: ['auto-discovered', 'hot_file'],
        metadata: '{}',
      }),
    );

    const result = await surface(
      { queries, embeddingIndex: notReadyIndex },
      { prompt: 'dreaming layer consolidation', projectScope: 'project:memstack' },
    );

    const keys = result.conventions.map(c => c.key);
    expect(keys).toContain('convention:memstack'); // curated catalog → surfaced
    expect(result.conventions).toHaveLength(1); // the non-catalog project memory is excluded
    expect(keys.every(k => !k.startsWith('mem:'))).toBe(true); // no unstable fallback key leaked
  });

  // Extra: tools come back as 'hard' binding
  it('tools have binding "hard"', async () => {
    await addCatalogMemory(queries, {
      scope: 'client:claude-tool',
      name: 'MEMSTACK',
      externalKey: 'tool:memstack',
      description: '5-layer memory stack with hybrid search',
      tags: ['claude-index', 'tool'],
    });

    const result = await surface(
      { queries, embeddingIndex: notReadyIndex },
      { prompt: 'memstack memory search tool' },
    );

    expect(result.tools.length).toBeGreaterThan(0);
    for (const t of result.tools) {
      expect(t.binding).toBe('hard');
    }
  });

  // Extra: dedup — same memory id cannot appear in two classes
  it('deduplicates across classes (same id appears only once)', async () => {
    // Seed one memory under client:claude-tool; it should only appear as a tool.
    const id = await addCatalogMemory(queries, {
      scope: 'client:claude-tool',
      name: 'MEMSTACK Tool',
      externalKey: 'tool:memstack',
      description: 'memstack memory search hybrid',
      tags: ['claude-index', 'tool'],
    });

    // The same memory cannot physically be in client:claude-skill scope, but
    // we can verify the dedup logic by checking class purity.
    const result = await surface(
      { queries, embeddingIndex: notReadyIndex },
      { prompt: 'memstack hybrid search memory' },
    );

    const allIds = [
      ...result.tools.map(t => t.key),
      ...result.skills.map(s => s.key),
      ...result.conventions.map(c => c.key),
    ];
    const unique = new Set(allIds);
    expect(allIds.length).toBe(unique.size);
    void id;
  });

  // Extra: semantic ranking used when embedder is ready — the closest match ranks first
  it('uses semantic search when embedder is ready — closest match ranks first', async () => {
    mockEmbedderReady = true;

    // Two tools. Tool Alpha has cosine=1.0 against the query; Tool Beta has cosine=0.
    // Both will appear (RRF assigns nonzero rank to every candidate in scope) but
    // Alpha must rank first (higher RRF because it ranks #1 in semantic).
    const toolAId = await addCatalogMemory(queries, {
      scope: 'client:claude-tool',
      name: 'Tool Alpha',
      externalKey: 'tool:alpha',
      description: 'alpha memory search retrieval',
      tags: ['claude-index', 'tool'],
    });
    const toolBId = await addCatalogMemory(queries, {
      scope: 'client:claude-tool',
      name: 'Tool Beta',
      externalKey: 'tool:beta',
      description: 'unrelated content xyz',
      tags: ['claude-index', 'tool'],
    });

    const queryVec = new Float32Array(384);
    queryVec[0] = 1.0; // unit vector in dim 0

    const toolAVec = new Float32Array(384);
    toolAVec[0] = 1.0; // same direction → cosine = 1.0

    const toolBVec = new Float32Array(384);
    toolBVec[1] = 1.0; // orthogonal → cosine = 0

    const stubIndex = makeStubIndex([
      { id: toolAId, vec: toolAVec },
      { id: toolBId, vec: toolBVec },
    ]);

    mockEmbed.mockImplementation(async () => queryVec);

    // Use caps: { tools: 1 } so only the single best match is returned —
    // that must be Tool Alpha (cosine=1 → rank #1 in semantic → highest RRF).
    const result = await surface(
      { queries, embeddingIndex: stubIndex },
      { prompt: 'alpha memory search', caps: { tools: 1 } },
    );

    expect(result.tools.length).toBe(1);
    expect(result.tools[0].key).toBe('tool:alpha');
    expect(result.tools[0].binding).toBe('hard');

    void toolBId; // referenced implicitly
  });

  // Extra: result shape contract — every item has all required fields
  it('result items satisfy the output contract (class/key/title/content/score/binding)', async () => {
    await addCatalogMemory(queries, {
      scope: 'client:claude-skill',
      name: 'Handoff',
      externalKey: 'skill:handoff',
      description: 'Generate handoff prompt',
      tags: ['claude-index', 'skill'],
    });

    const result = await surface(
      { queries, embeddingIndex: notReadyIndex },
      { prompt: 'generate handoff prompt session' },
    );

    for (const cls of ['tools', 'skills', 'conventions'] as const) {
      for (const item of result[cls]) {
        expect(typeof item.class).toBe('string');
        expect(['tool', 'skill', 'convention']).toContain(item.class);
        expect(typeof item.key).toBe('string');
        expect(item.key.length).toBeGreaterThan(0);
        expect(typeof item.title).toBe('string');
        expect(typeof item.content).toBe('string');
        expect(typeof item.score).toBe('number');
        expect(item.score).toBeGreaterThan(0);
        expect(['hard', 'advisory']).toContain(item.binding);
      }
    }
  });
});
