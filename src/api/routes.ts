import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { IMemoryStore } from '../database/interfaces.js';
import { embed, embedWithModel, embeddingToBuffer, isEmbedderReady } from '../embeddings/embedder.js';
import { hybridSearch } from '../search/hybrid.js';
import type { Memory, MemoryType } from '../types/types.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';
// Neo4j graph imports
import { getSession } from '../graph/neo4j.js';
import { traverseEntity, getGraphStats, getBipartiteGraph } from '../graph/graph-queries.js';
import { processMemoryForGraph } from '../graph/extraction-pipeline.js';
// MinIO storage imports
import { storeArtifact, getArtifact, getArtifactUrl, listArtifacts, deleteArtifact, getStorageStats } from '../storage/minio.js';
// Discovery imports
import { scrubSecrets, truncate, shouldSuppressOutput, stripUnstorableCharsDeep } from '../utils/scrubber.js';
import { runDiscoveryMaintenance } from '../discovery/maintenance.js';
import type { ObservationEvent } from '../services/observation-bus.js';
import { isActivityPath } from '../dreaming/activity-tracker.js';
// Dreaming review/apply surface (D1.3)
import { ConsolidationLockManager, uniqueHolder } from '../dreaming/lock.js';
import { resolveDream, rollbackMemory } from '../dreaming/apply.js';
import type { DreamDiff, DreamChangeClass } from '../types/types.js';
import type { AppContext } from '../types/app-context.js';
// Static surfacing (C1.2 / T12)
import { surface } from '../surfacing/surface.js';
// Corpus-health derived signals (ops endpoint)
import { memoryStrength } from '../dreaming/scoring.js';
import { cosineSimilarity, COSINE_DUPLICATE_THRESHOLD, classifyDupPair } from '../dreaming/pipeline.js';
import { bufferToEmbedding } from '../embeddings/embedder.js';

// Zod schemas
const MemoryTypeEnum = z.enum(['user', 'feedback', 'project', 'reference', 'discovery']);

const StoreSchema = z.object({
  content: z.string().min(1).max(config.search.maxContentSize),
  type: MemoryTypeEnum.default('reference'),
  scope: z.string().default('global'),
  source: z.string().optional(),
  source_path: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
  tags: z.array(z.string()).default([]),
  created_by: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const TriggerDreamSchema = z.object({
  reason: z.string().max(500).optional(),
  dry_run: z.boolean().default(false),
  // R2: explicit window override — lets a manual trigger run again after the
  // nightly window has already collapsed for the day.
  window_key: z.string().min(1).max(64).optional(),
  // T6: 'whole_corpus' runs the heavy whole-corpus pass (every active id,
  // id-segment reasoner gate) — the manual activation path (T17). Omitted /
  // 'windowed' = the nightly rotating window. A scheduled whole-corpus sweep
  // exists but ships cadence-off (`dream_whole_corpus_cadence`); this trigger runs
  // one on demand regardless.
  mode: z.enum(['windowed', 'whole_corpus']).optional(),
});

const ResolveDreamSchema = z.object({
  action: z.enum(['accept', 'reject']),
  // Narrowing to a subset is how a partial resolution happens.
  entry_indices: z.array(z.number().int().min(0)).min(1).optional(),
});

const RollbackSchema = z.object({
  // Defaults to the latest revision when omitted.
  revision: z.number().int().min(1).optional(),
});

const SurfaceSchema = z.object({
  prompt: z.string().min(1).max(2000),
  /** Caller-derived project scope (e.g. `project:kopeng`). Takes priority over cwd. */
  project_scope: z.string().optional(),
  /** Raw cwd — basename is used as a fallback project scope when project_scope is absent. */
  cwd: z.string().optional(),
  caps: z
    .object({
      tools: z.number().int().min(0).max(10).optional(),
      skills: z.number().int().min(0).max(10).optional(),
      conventions: z.number().int().min(0).max(10).optional(),
    })
    .optional(),
});

const HOUR_MINUTE = /^([01]\d|2[0-3]):[0-5]\d$/;
const OperatorConfigPatchSchema = z.object({
  timezone: z.string().min(1).max(64).optional(),
  quiet_hours_start: z.string().regex(HOUR_MINUTE, 'expected HH:MM').optional(),
  quiet_hours_end: z.string().regex(HOUR_MINUTE, 'expected HH:MM').optional(),
  idle_minutes: z.number().int().min(1).max(1440).optional(),
  dream_cadence: z.string().max(64).optional(),
  auto_accept_exact_dup: z.boolean().optional(),
  auto_accept_decay: z.boolean().optional(),
  reasoner_provider: z.string().max(128).optional(),
  config: z.record(z.unknown()).optional(),
});

const BatchStoreSchema = z.object({
  memories: z.array(StoreSchema).min(1).max(100),
});

const UpdateSchema = z.object({
  content: z.string().min(1).max(config.search.maxContentSize).optional(),
  type: MemoryTypeEnum.optional(),
  scope: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  // F3/T22: confidence is the anchor-triage surface (demote a legacy 1.0 anchor,
  // or deliberately re-anchor). A change is snapshot-first + reversible via the
  // rollback API (see the PUT handler). Bounds mirror the store: 0..1.
  confidence: z.number().min(0).max(1).optional(),
});

const SearchSchema = z.object({
  query: z.string().min(1).max(1000),
  mode: z.enum(['hybrid', 'semantic', 'keyword']).default('hybrid'),
  type: MemoryTypeEnum.optional(),
  scope: z.string().optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(config.search.maxLimit).default(config.search.defaultLimit),
  offset: z.number().int().min(0).default(0),
  include_archived: z.boolean().default(false),
  rerank: z.boolean().optional(),
  rerank_candidates: z.number().int().min(1).max(100).optional(),
});

const ArchiveSchema = z.object({
  archive: z.boolean(),
});

const ForceArchiveQuerySchema = z.object({
  force: z.coerce.boolean().default(false),
});

const ListQuerySchema = z.object({
  type: MemoryTypeEnum.optional(),
  scope: z.string().optional(),
  tags: z.string().optional(), // comma-separated
  // Lite pages (no embedding column) may go up to 1000 rows; full pages are
  // clamped to config.search.maxLimit in the handler. The viz graph pages the
  // whole corpus at startup — big lite pages cut ~41 round-trips to ~5.
  limit: z.coerce.number().int().min(1).max(1000).default(config.search.defaultLimit),
  cursor: z.coerce.number().int().optional(),
  include_archived: z.coerce.boolean().default(false),
  fields: z.enum(['full', 'lite']).default('full'),
});

// Ops: dream history + corpus health query params.
const DreamHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const CorpusHealthQuerySchema = z.object({
  // Bounds the cost of the O(n^2) duplicate-pair scan + per-row decay compute.
  sample: z.coerce.number().int().min(1).max(10000).default(2000),
});

const SlotKeySchema = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const SlotCreateSchema = z.object({
  slot_key: SlotKeySchema,
  content: z.string().min(1).max(config.search.maxContentSize),
  type: MemoryTypeEnum,
  scope: z.string(),
  tags: z.array(z.string()).default([]),
});

const SlotUpdateSchema = z.object({
  content: z.string().min(1).max(config.search.maxContentSize).optional(),
  type: MemoryTypeEnum.optional(),
  scope: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const startTime = Date.now();

type TaggedMemory = Memory & { tags: string[] };
type SlotMemory = TaggedMemory & { slot_key: string };

function parseMetadata(metadata: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Plain-language translation of what accept/reject literally do to the corpus,
 * per change_class. Purely a fixed lookup — no reasoner involvement — so it's
 * safe to compute for every entry regardless of tier or auto-accept config.
 */
function describeDreamImpact(changeClass: DreamChangeClass): { if_accepted: string; if_rejected: string; reversible: boolean } {
  switch (changeClass) {
    case 'exact_dup':
      return {
        if_accepted: 'Archives the duplicate memory (byte-identical content), keeps the other. The archived one stops showing up in search/recall.',
        if_rejected: 'Nothing changes — both memories stay active.',
        reversible: true,
      };
    case 'merge':
      return {
        if_accepted: 'Archives the weaker near-duplicate memory, keeps the stronger one. The archived one stops showing up in search/recall.',
        if_rejected: 'Nothing changes — both memories stay active.',
        reversible: true,
      };
    case 'decay':
      return {
        if_accepted: 'Archives this memory outright — it has aged past the point of being considered reliable/relevant. It stops showing up in search/recall.',
        if_rejected: 'Nothing changes — the memory stays active and keeps aging on its normal decay schedule.',
        reversible: true,
      };
    case 'supersede':
      return {
        if_accepted: 'The older memory is marked deprecated (but not deleted); the newer one becomes the "current" version. Both stay in the corpus, chained together.',
        if_rejected: 'Nothing changes — neither memory is marked, both remain equally current.',
        reversible: true,
      };
    case 'conditional':
      return {
        if_accepted: 'Creates one new memory encoding both conditions (e.g. "when X → A; when Y → B"), linked back to both sources. The two original memories are NOT deleted, but are flagged as contradicted and lose their accumulated durability — so they decay faster going forward while the new merged memory takes over.',
        if_rejected: 'Nothing changes — no new memory is created, both originals keep their current confidence and decay rate untouched.',
        reversible: true,
      };
    case 'contested':
      return {
        if_accepted: 'Not directly actionable — accepting just marks this entry reviewed. If you want to resolve the underlying conflict, you still need to manually update or archive one of the memories yourself.',
        if_rejected: 'Nothing changes — the flagged conflict stays exactly as-is.',
        reversible: true,
      };
    case 'reinforce':
      return {
        if_accepted: 'Reinforces an existing memory\'s confidence slightly rather than creating a duplicate.',
        if_rejected: 'Nothing changes.',
        reversible: false,
      };
    case 'promote_global':
      return {
        if_accepted: 'Diff-only signal — this entry itself makes no change. Promoting a cross-scope duplicate to global scope happens via the separate promotion pipeline, not this accept action.',
        if_rejected: 'Nothing changes.',
        reversible: true,
      };
    case 'rollback':
      return {
        if_accepted: 'Audit-only record of a previously executed rollback — not a proposal, nothing to accept or reject here.',
        if_rejected: 'N/A',
        reversible: true,
      };
    default:
      return {
        if_accepted: 'Applies the proposed change to the corpus.',
        if_rejected: 'Nothing changes.',
        reversible: true,
      };
  }
}

// Common English words to strip before building an FTS OR query from a natural
// language prompt.  The set is intentionally small — only words so common they
// drown rare proper-nouns (project names, design-system names, …) in BM25 ranking.
const RECALL_STOPWORDS = new Set([
  'about', 'above', 'after', 'also', 'back', 'based', 'been', 'both',
  'come', 'could', 'does', 'done', 'each', 'else', 'even', 'find',
  'from', 'give', 'good', 'have', 'help', 'here', 'high', 'into',
  'just', 'keep', 'kind', 'know', 'like', 'look', 'make', 'many',
  'more', 'most', 'move', 'much', 'need', 'next', 'only', 'open',
  'over', 'part', 'play', 'plus', 'quick', 'same', 'seem', 'show',
  'side', 'some', 'such', 'take', 'than', 'that', 'them', 'then',
  'there', 'they', 'think', 'this', 'time', 'turn', 'under', 'upon',
  'used', 'very', 'want', 'ways', 'well', 'what', 'when', 'where',
  'which', 'while', 'will', 'with', 'work', 'would', 'your',
]);

/**
 * Extract meaningful tokens from a natural language query string and return a
 * FTS5-compatible OR query (e.g. `"acme" OR "remix" OR "workflows"`).
 * Returns null if no tokens survive the stopword filter.
 */
function extractFtsTokens(query: string, maxTokens = 8): string | null {
  const tokens = [...new Set(
    (query.toLowerCase().match(/\b[a-z][a-z]{3,}\b/g) ?? [])
      .filter(t => !RECALL_STOPWORDS.has(t))
  )];
  if (tokens.length === 0) return null;
  return tokens.slice(0, maxTokens).map(t => `"${t}"`).join(' OR ');
}

/**
 * Return true if any trigger term appears as a whole word in the query
 * (case-insensitive, word-boundary match).
 */
function matchesTriggerTerms(triggerTerms: string[], query: string): boolean {
  const q = query.toLowerCase();
  return triggerTerms.some(term => {
    const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(q);
  });
}

function toSlotMemory(memory: TaggedMemory): SlotMemory | null {
  const metadata = parseMetadata(memory.metadata);
  const slotKey = metadata.slot_key;
  if (metadata.pinned !== true || typeof slotKey !== 'string') return null;
  return { ...memory, slot_key: slotKey };
}

async function listSlotMemories(queries: IMemoryStore): Promise<SlotMemory[]> {
  const slots: SlotMemory[] = [];
  let cursor: number | undefined;
  do {
    const result = await queries.list({
      cursor,
      limit: config.search.maxLimit,
      include_archived: false,
    });
    for (const memory of result.memories) {
      const slot = toSlotMemory(memory);
      if (slot) slots.push(slot);
    }
    cursor = result.memories.length > 0 ? result.memories[result.memories.length - 1].id : undefined;
    if (!result.has_more) break;
  } while (cursor !== undefined);

  return slots.sort((a, b) => a.slot_key.localeCompare(b.slot_key));
}

async function getSlotMemory(queries: IMemoryStore, slotKey: string): Promise<SlotMemory | null> {
  const normalized = slotKey.toLowerCase();
  const slots = await listSlotMemories(queries);
  return slots.find(slot => slot.slot_key.toLowerCase() === normalized) ?? null;
}

function isPinnedSlot(memory: TaggedMemory): boolean {
  return parseMetadata(memory.metadata).pinned === true;
}

/**
 * Reinforcement-on-access (D1.1): memories genuinely surfaced to the caller
 * get observation_count+1 and a fresh last_seen, resetting their decay clock.
 * Fire-and-forget — never blocks or fails the response.
 */
function reinforceSurfaced(queries: IMemoryStore, ids: number[]): void {
  if (ids.length === 0) return;
  queries.reinforceOnAccess(ids).catch(err => {
    logger.warn('reinforceOnAccess failed:', err);
  });
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  // R7: destructure the AppContext once — route bodies keep their original names.
  const { queries, observations: observationStore, dreams: dreamStore, operatorConfig: operatorConfigStore } = ctx.stores;
  const { embeddingIndex, memoryCache, discoveryScheduler, observationBus, activityTracker, dreamRunner, reasonerStatus } = ctx.services;
  const dbLifecycle = ctx.lifecycle;

  // Admin-key gate. Originally only the operator-mutating endpoints (PATCH
  // /api/operator-config, dream trigger/resolve, admin promote, rollback) were
  // gated; later widened to EVERY mutating route — core memory CRUD, slots,
  // Redis context, and MinIO artifacts — because none of them had any auth at
  // all. That mattered more here than an open read would: anyone who could
  // reach the port could inject a memory that a model later recalls and acts
  // on, which is prompt injection with persistence.
  //
  // Reads stay public, INCLUDING the POST-shaped ones (/api/memories/recall,
  // /search, /surface, /traverse) — the recall hooks call those on every prompt
  // with no key, and gating them would silently break recall for every client.
  //
  // Same posture as the observation requireApiKey: no key configured = open
  // (dev mode). That is why the shipped default binds loopback: with no key set
  // this gate is a no-op, so the bind address is the only control left.
  const requireAdminKey = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.server.adminApiKey) return; // No key configured = open (dev mode)
    const apiKey = request.headers['x-api-key'];
    if (apiKey !== config.server.adminApiKey) {
      // Logged, not silent: widening this gate to core CRUD can strand a client
      // nobody remembered (a scheduled task, a script on another machine). A
      // rejection has to be discoverable from the logs, or the failure mode is
      // "that automation just quietly stopped working" — the shape of a silent
      // capture outage. Method+path+UA only; no header or body content.
      logger.warn(
        `Admin-gated request rejected: ${request.method} ${request.url} from ${request.ip} ` +
        `(ua: ${request.headers['user-agent'] || 'none'}; key: ${apiKey ? 'wrong' : 'missing'})`,
      );
      reply.status(401).send({ error: 'Invalid or missing admin API key' });
    }
  };

  // Add API version header to all responses
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-API-Version', '1');
  });

  // D0.5: stamp operator activity for the dream idle-detector. Excludes health,
  // ops, dream, and SSE-heartbeat traffic so background polling never resets the
  // idle clock (which would keep the system looking awake and block all dreaming).
  if (activityTracker) {
    app.addHook('onRequest', async (request) => {
      if (isActivityPath(request.method, request.url)) activityTracker.stamp();
    });
  }

  // --- Health ---
  app.get('/api/health', async () => {
    const memoryCount = await queries.getCount();
    return {
      data: {
        status: isEmbedderReady() ? 'ready' : 'loading',
        embedding: isEmbedderReady() ? 'loaded' : 'initializing',
        search: isEmbedderReady() ? 'hybrid' : (memoryCount > 0 ? 'keyword_only' : 'unavailable'),
        memories: memoryCount,
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      },
    };
  });

  // --- Stats ---
  app.get('/api/stats', async () => {
    const dbStats = await dbLifecycle.getStats();
    return {
      data: {
        ...dbStats,
        by_type: await queries.getTypeStats(),
        by_scope: await queries.getScopeStats(),
        embedding_index_size: embeddingIndex.size,
        fts_entries: await queries.getFtsCount(),
      },
    };
  });

  // --- Slots ---
  app.get('/api/slots', async () => {
    return { data: await listSlotMemories(queries) };
  });

  app.get('/api/slots/:slot_key', async (request, reply) => {
    const { slot_key } = request.params as { slot_key: string };
    const slot = await getSlotMemory(queries, slot_key);
    if (!slot) {
      reply.status(404);
      return { error: 'Slot not found' };
    }
    return { data: slot };
  });

  app.post('/api/slots', { preHandler: [requireAdminKey] }, async (request, reply) => {
    const input = SlotCreateSchema.parse(request.body);
    const existing = await getSlotMemory(queries, input.slot_key);
    if (existing) {
      reply.status(409);
      return { error: 'Slot key already exists' };
    }

    let embeddingBuf: Buffer | null = null;
    if (isEmbedderReady()) {
      const vec = await embed(input.content);
      embeddingBuf = embeddingToBuffer(vec);
    }

    const result = await queries.store({
      content: input.content,
      type: input.type,
      scope: input.scope,
      source: 'slot',
      source_path: null,
      metadata: JSON.stringify({ pinned: true, slot_key: input.slot_key }),
      embedding: embeddingBuf,
      embedding_model: config.embedding.model,
      created_by: null,
      tags: input.tags,
    });

    if (embeddingBuf && !result.deduplicated) {
      const vec = new Float32Array(embeddingBuf.buffer, embeddingBuf.byteOffset, embeddingBuf.byteLength / 4);
      await embeddingIndex.add(result.id, vec);
    }

    const memory = await queries.get(result.id);
    const slot = memory ? toSlotMemory(memory) : null;
    if (!slot) {
      reply.status(500);
      return { error: 'Failed to create slot' };
    }

    reply.status(201);
    return { data: slot };
  });

  app.put('/api/slots/:slot_key', { preHandler: [requireAdminKey] }, async (request, reply) => {
    const { slot_key } = request.params as { slot_key: string };
    const input = SlotUpdateSchema.parse(request.body);
    const existing = await getSlotMemory(queries, slot_key);
    if (!existing) {
      reply.status(404);
      return { error: 'Slot not found' };
    }

    const metadata = {
      ...parseMetadata(existing.metadata),
      pinned: true,
      slot_key: existing.slot_key,
    };

    const result = await queries.update(existing.id, {
      content: input.content ?? existing.content,
      type: input.type ?? existing.type,
      scope: input.scope ?? existing.scope,
      metadata: JSON.stringify(metadata),
      tags: input.tags ?? existing.tags,
    });

    if (result.contentChanged && isEmbedderReady() && input.content) {
      const vec = await embed(input.content);
      const buf = embeddingToBuffer(vec);
      await queries.setEmbedding(existing.id, buf, config.embedding.model);
      await embeddingIndex.add(existing.id, vec);
    }

    const updated = await queries.get(existing.id);
    const slot = updated ? toSlotMemory(updated) : null;
    if (!slot) {
      reply.status(500);
      return { error: 'Failed to update slot' };
    }

    return { data: slot };
  });

  app.delete('/api/slots/:slot_key', { preHandler: [requireAdminKey] }, async (request, reply) => {
    const { slot_key } = request.params as { slot_key: string };
    const existing = await getSlotMemory(queries, slot_key);
    if (!existing) {
      reply.status(404);
      return { error: 'Slot not found' };
    }

    const archived = await queries.archive(existing.id);
    if (!archived) {
      reply.status(404);
      return { error: 'Slot not found' };
    }
    await embeddingIndex.remove(existing.id);

    reply.status(204);
    return undefined;
  });

  // --- Store memory ---
  app.post('/api/memories', { preHandler: [requireAdminKey] }, async (request, reply) => {
    const start = Date.now();
    const input = StoreSchema.parse(request.body);

    let embeddingBuf: Buffer | null = null;
    if (isEmbedderReady()) {
      const vec = await embed(input.content);
      embeddingBuf = embeddingToBuffer(vec);
    }

    const result = await queries.store({
      content: input.content,
      type: input.type,
      scope: input.scope,
      source: input.source || null,
      source_path: input.source_path || null,
      metadata: JSON.stringify(input.metadata),
      embedding: embeddingBuf,
      embedding_model: config.embedding.model,
      created_by: input.created_by || null,
      tags: input.tags,
      confidence: input.confidence,
    });

    // Update in-memory index
    if (embeddingBuf && !result.deduplicated) {
      const vec = new Float32Array(embeddingBuf.buffer, embeddingBuf.byteOffset, embeddingBuf.byteLength / 4);
      await embeddingIndex.add(result.id, vec);
    }

    const memory = await queries.get(result.id);
    reply.status(result.deduplicated ? 200 : 201);
    return {
      data: memory,
      meta: { deduplicated: result.deduplicated, duration_ms: Date.now() - start },
    };
  });

  // --- Batch store ---
  app.post('/api/memories/batch', { preHandler: [requireAdminKey] }, async (request) => {
    const start = Date.now();
    const input = BatchStoreSchema.parse(request.body);

    const items = [];
    for (const mem of input.memories) {
      let embeddingBuf: Buffer | null = null;
      if (isEmbedderReady()) {
        const vec = await embed(mem.content);
        embeddingBuf = embeddingToBuffer(vec);
      }

      items.push({
        content: mem.content,
        type: mem.type,
        scope: mem.scope,
        source: mem.source || null,
        source_path: mem.source_path || null,
        metadata: JSON.stringify(mem.metadata),
        embedding: embeddingBuf,
        embedding_model: config.embedding.model,
        created_by: mem.created_by || null,
        tags: mem.tags,
        confidence: mem.confidence,
      });
    }

    const result = await queries.storeBatch(items);

    // Update in-memory index for new entries
    for (let i = 0; i < result.ids.length; i++) {
      if (items[i].embedding) {
        const buf = items[i].embedding!;
        const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        await embeddingIndex.add(result.ids[i], vec);
      }
    }

    return {
      data: { ids: result.ids, duplicates: result.duplicates, inserted: result.ids.length - result.duplicates },
      meta: { duration_ms: Date.now() - start },
    };
  });

  // --- Get memory by ID ---
  app.get('/api/memories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const memId = parseInt(id, 10);
    if (isNaN(memId)) { reply.status(400); return { error: 'Invalid memory ID' }; }
    const memory = await queries.get(memId);
    if (!memory) {
      reply.status(404);
      return { error: 'Memory not found' };
    }
    reinforceSurfaced(queries, [memory.id]);
    return { data: memory };
  });

  // --- Get related memories ---
  app.get('/api/memories/:id/related', async (request, reply) => {
    const start = Date.now();
    const { id } = request.params as { id: string };
    const memId = parseInt(id, 10);
    if (isNaN(memId)) { reply.status(400); return { error: 'Invalid memory ID' }; }
    const memory = await queries.get(memId);
    if (!memory) {
      return { error: 'Memory not found' };
    }

    if (!isEmbedderReady() || !memory.embedding) {
      return { data: [], meta: { duration_ms: Date.now() - start } };
    }

    const queryVec = new Float32Array(
      (memory.embedding as Buffer).buffer,
      (memory.embedding as Buffer).byteOffset,
      (memory.embedding as Buffer).byteLength / 4
    );

    const results = await embeddingIndex.search(queryVec, undefined, 11); // +1 to exclude self
    const related = [];
    for (const r of results) {
      if (r.id === memId) continue;
      const mem = await queries.get(r.id);
      if (mem) related.push({ memory: mem, score: r.score });
      if (related.length >= 10) break;
    }

    return { data: related, meta: { duration_ms: Date.now() - start } };
  });

  // --- Update memory ---
  app.put('/api/memories/:id', { preHandler: [requireAdminKey] }, async (request, reply) => {
    const start = Date.now();
    const { id } = request.params as { id: string };
    const memoryId = parseInt(id, 10);
    if (isNaN(memoryId)) { reply.status(400); return { error: 'Invalid memory ID' }; }
    const input = UpdateSchema.parse(request.body);

    const existing = await queries.get(memoryId);
    if (!existing) {
      return { error: 'Memory not found' };
    }

    // F3/T22: a confidence change is snapshot-first (mirror the dream apply
    // path's snapshot->mutate discipline) so a manual demotion / re-anchor is
    // reversible via POST /api/memories/:id/rollback. Snapshot BEFORE any
    // mutation captures the pre-change confidence (+ content/tags) into
    // memory_revisions — the append-only audit record rollback restores from.
    const confidenceChanged =
      input.confidence !== undefined && input.confidence !== existing.confidence;
    if (confidenceChanged && dreamStore) {
      await dreamStore.snapshotRevision(memoryId);
    }

    const result = await queries.update(memoryId, {
      content: input.content ?? existing.content,
      type: (input.type ?? existing.type) as MemoryType,
      scope: input.scope ?? existing.scope,
      metadata: input.metadata ? JSON.stringify(input.metadata) : existing.metadata,
      tags: input.tags ?? existing.tags,
    });

    // Re-embed if content changed
    if (result.contentChanged && isEmbedderReady() && input.content) {
      const vec = await embed(input.content);
      const buf = embeddingToBuffer(vec);
      await queries.setEmbedding(memoryId, buf, config.embedding.model);
      await embeddingIndex.add(memoryId, vec);
    }

    if (confidenceChanged) {
      await queries.updateConfidence(memoryId, input.confidence!);
    }

    const updated = await queries.get(memoryId);
    return {
      data: updated,
      meta: {
        content_changed: result.contentChanged,
        confidence_changed: confidenceChanged,
        duration_ms: Date.now() - start,
      },
    };
  });

  // --- Archive/Unarchive ---
  app.patch('/api/memories/:id', { preHandler: [requireAdminKey] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const memoryId = parseInt(id, 10);
    if (isNaN(memoryId)) { reply.status(400); return { error: 'Invalid memory ID' }; }
    const input = ArchiveSchema.parse(request.body);
    const query = ForceArchiveQuerySchema.parse(request.query);

    let success: boolean;
    if (input.archive) {
      const memory = await queries.get(memoryId);
      if (!memory) {
        reply.status(404);
        return { error: 'Memory not found' };
      }
      if (isPinnedSlot(memory) && !query.force) {
        reply.status(409);
        return { error: 'Cannot archive a pinned slot. Use DELETE /api/slots/:slot_key or pass ?force=true' };
      }
      success = await queries.archive(memoryId);
      await embeddingIndex.remove(memoryId);
    } else {
      success = await queries.unarchive(memoryId);
      // Reload embedding into index
      const memory = await queries.get(memoryId);
      if (memory?.embedding) {
        const buf = memory.embedding as Buffer;
        const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        await embeddingIndex.add(memoryId, vec);
      }
    }

    if (!success) {
      return { error: 'Memory not found' };
    }

    return { data: { id: memoryId, archived: input.archive } };
  });

  app.post('/api/memories/:id/archive', { preHandler: [requireAdminKey] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const memoryId = parseInt(id, 10);
    if (isNaN(memoryId)) { reply.status(400); return { error: 'Invalid memory ID' }; }
    const query = ForceArchiveQuerySchema.parse(request.query);

    const memory = await queries.get(memoryId);
    if (!memory) {
      reply.status(404);
      return { error: 'Memory not found' };
    }
    if (isPinnedSlot(memory) && !query.force) {
      reply.status(409);
      return { error: 'Cannot archive a pinned slot. Use DELETE /api/slots/:slot_key or pass ?force=true' };
    }

    const success = await queries.archive(memoryId);
    if (!success) {
      reply.status(404);
      return { error: 'Memory not found' };
    }

    await embeddingIndex.remove(memoryId);
    return { data: { id: memoryId, archived: true } };
  });

  // --- Fast recall (hybrid-lite: semantic + FTS + staple injection, no reranking) ---
  app.post('/api/memories/recall', async (request) => {
    const start = Date.now();
    const input = z.object({
      query: z.string().min(1).max(1000),
      scope: z.string().optional(),
      scopes: z.array(z.string()).optional(),
      threshold: z.number().min(0).max(1).default(0.40),
      limit: z.number().int().min(1).max(10).default(3),
    }).parse(request.body);

    if (!isEmbedderReady()) {
      return { data: [], meta: { duration_ms: Date.now() - start } };
    }

    const queryVec = await embed(input.query);

    // Normalize: accept both `scope` (string) and `scopes` (array); `scopes` takes priority
    const requestedScopes: string[] = input.scopes ?? (input.scope ? [input.scope] : []);

    // Get scope-filtered candidate IDs. Multiple scopes → union of IDs (no cross-project bleed).
    let candidateIds: number[] | undefined;
    if (requestedScopes.length > 0) {
      if (requestedScopes.length === 1) {
        const [singleScope] = requestedScopes;
        candidateIds = await queries.getFilteredIds({ scope: singleScope, include_archived: false });
        if (candidateIds.length === 0 && singleScope !== 'global') {
          // Single-scope fallback: project has no memories → search global only
          candidateIds = await queries.getFilteredIds({ scope: 'global', include_archived: false });
          if (candidateIds.length === 0) {
            return { data: [], meta: { duration_ms: Date.now() - start } };
          }
        }
      } else {
        const idSets = await Promise.all(
          requestedScopes.map(s => queries.getFilteredIds({ scope: s, include_archived: false }))
        );
        candidateIds = [...new Set(idSets.flat())];
        if (candidateIds.length === 0) {
          return { data: [], meta: { duration_ms: Date.now() - start } };
        }
      }
    }

    const candidateSet = candidateIds ? new Set(candidateIds) : null;
    const ftsQuery = extractFtsTokens(input.query);

    // ── Parallel: semantic + FTS + staple IDs ──
    const [vectorResults, ftsRows, stapleIds] = await Promise.all([
      embeddingIndex.search(queryVec, candidateIds, input.limit * 4),
      ftsQuery
        ? queries.searchFts(ftsQuery, input.limit * 4)
            .then(rows => (candidateSet ? rows.filter(r => candidateSet.has(r.rowid)) : rows))
            .catch(() => [] as { rowid: number; rank: number }[])
        : Promise.resolve([] as { rowid: number; rank: number }[]),
      queries.getFilteredIds({ tags: ['staple'], include_archived: false }),
    ]);

    const ftsIdSet = new Set(ftsRows.map(r => r.rowid));

    // ── Staple injection: memories tagged `staple` whose trigger_terms match the query ──
    // Staples bypass scope filtering and the semantic threshold — they represent
    // identity-level facts that must never be missed regardless of prompt length.
    const stapleHits = new Map<number, TaggedMemory>(); // id → prefetched memory
    for (const sid of stapleIds) {
      const smem = await queries.get(sid);
      if (!smem) continue;
      const meta = parseMetadata(smem.metadata);
      const terms = Array.isArray(meta.trigger_terms)
        ? (meta.trigger_terms as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      if (terms.length > 0 && matchesTriggerTerms(terms, input.query)) {
        stapleHits.set(sid, smem);
      }
    }

    // ── RRF merge: semantic + FTS (staples override with score 0.99) ──
    const K = 60;
    const rrfScores = new Map<number, number>();
    vectorResults.forEach((r, i) => rrfScores.set(r.id, (rrfScores.get(r.id) ?? 0) + 1 / (K + i + 1)));
    ftsRows.forEach((r, i) => rrfScores.set(r.rowid, (rrfScores.get(r.rowid) ?? 0) + 1 / (K + i + 1)));
    for (const id of stapleHits.keys()) rrfScores.set(id, 0.99);

    const sortedEntries = [...rrfScores.entries()].sort((a, b) => b[1] - a[1]);
    const semanticScores = new Map(vectorResults.map(r => [r.id, r.score]));

    // ── Build response ──
    // Staples bypass threshold; all others need semScore >= threshold OR an FTS hit.
    // The result cap is limit + staple count so injected staples never evict semantic results.
    const totalLimit = input.limit + stapleHits.size;
    const memories = [];
    const includedIds = new Set<number>();

    for (const [id, rrfScore] of sortedEntries) {
      if (memories.length >= totalLimit) break;
      if (includedIds.has(id)) continue;

      const isStaple = stapleHits.has(id);
      const semScore = semanticScores.get(id) ?? 0;

      if (!isStaple && semScore < input.threshold && !ftsIdSet.has(id)) continue;

      const mem = stapleHits.get(id) ?? await queries.get(id);
      if (!mem) continue;
      memories.push({
        id: mem.id,
        content: mem.content,
        type: mem.type,
        scope: mem.scope,
        // T29: tags travel with recall results so the recall hook can detect the
        // `critical` turn-gate flag without a second round-trip (additive field;
        // existing consumers ignore it).
        tags: mem.tags,
        score: isStaple ? 0.99 : semScore || rrfScore,
      });
      includedIds.add(id);
    }

    reinforceSurfaced(queries, memories.map(m => m.id));

    return {
      data: memories,
      meta: { duration_ms: Date.now() - start },
    };
  });

  // --- Search ---
  app.post('/api/memories/search', async (request) => {
    const start = Date.now();
    const input = SearchSchema.parse(request.body);

    const { results, total, reranked } = await hybridSearch(queries, embeddingIndex, {
      query: input.query,
      mode: input.mode,
      type: input.type,
      scope: input.scope,
      tags: input.tags,
      limit: input.limit,
      offset: input.offset,
      include_archived: input.include_archived,
      rerank: input.rerank,
      rerank_candidates: input.rerank_candidates,
    });

    reinforceSurfaced(queries, results.map(r => r.memory.id));

    return {
      data: results,
      meta: {
        total,
        limit: input.limit,
        offset: input.offset,
        has_more: input.offset + input.limit < total,
        reranked,
        duration_ms: Date.now() - start,
      },
    };
  });

  // --- List memories ---
  app.get('/api/memories', async (request) => {
    const start = Date.now();
    const raw = request.query as Record<string, string>;
    const input = ListQuerySchema.parse(raw);

    const tags = input.tags ? input.tags.split(',').map(t => t.trim()).filter(Boolean) : undefined;
    const lite = input.fields === 'lite';
    const limit = lite ? input.limit : Math.min(input.limit, config.search.maxLimit);

    const { memories, has_more } = await queries.list({
      type: input.type,
      scope: input.scope,
      tags,
      cursor: input.cursor,
      limit,
      include_archived: input.include_archived,
      lite,
    });

    const nextCursor = memories.length > 0 ? memories[memories.length - 1].id : undefined;

    return {
      data: memories,
      meta: {
        limit,
        cursor: nextCursor,
        has_more,
        duration_ms: Date.now() - start,
      },
    };
  });

  // --- Admin: Backup ---
  app.post('/api/admin/backup', { preHandler: [requireAdminKey] }, async () => {
    const start = Date.now();
    const backupPath = await dbLifecycle.backup();
    return {
      data: { backup_path: backupPath },
      meta: { duration_ms: Date.now() - start },
    };
  });

  // --- Admin: Reindex ---
  app.post('/api/admin/reindex', { preHandler: [requireAdminKey] }, async () => {
    const start = Date.now();

    // Rebuild FTS5
    await queries.rebuildFts();
    logger.info('FTS5 index rebuilt');

    // Rebuild embedding index
    const rows = await queries.loadAllEmbeddings();
    await embeddingIndex.loadFromDatabase(rows);
    logger.info('Embedding index rebuilt');

    return {
      data: {
        fts_entries: await queries.getFtsCount(),
        embedding_entries: embeddingIndex.size,
      },
      meta: { duration_ms: Date.now() - start },
    };
  });

  // ========== Neo4j Graph Endpoints (Phase 2) ==========

  if (config.neo4j.enabled) {
    // --- Graph traversal ---
    app.post('/api/memories/traverse', async (request) => {
      const start = Date.now();
      const input = z.object({
        entity: z.string().min(1),
        max_depth: z.number().int().min(1).max(5).default(2),
        limit: z.number().int().min(1).max(100).default(20),
      }).parse(request.body);

      const session = getSession();
      try {
        const result = await traverseEntity(session, input.entity, input.max_depth, input.limit);

        // Fetch memory summaries for connected IDs
        const memories = [];
        for (const memId of result.connectedMemoryIds.slice(0, input.limit)) {
          const mem = await queries.get(memId);
          if (mem) {
            memories.push({ id: mem.id, summary: mem.summary, type: mem.type, scope: mem.scope });
          }
        }

        return {
          data: { ...result, memories },
          meta: { duration_ms: Date.now() - start },
        };
      } finally {
        await session.close();
      }
    });

    // --- Process single memory for graph ---
    app.post('/api/memories/:id/graph', { preHandler: [requireAdminKey] }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const memoryId = parseInt(id, 10);
      if (isNaN(memoryId)) { reply.status(400); return { error: 'Invalid memory ID' }; }
      const memory = await queries.get(memoryId);
      if (!memory) return { error: 'Memory not found' };

      const session = getSession();
      try {
        const result = await processMemoryForGraph(
          session, memoryId, memory.content, memory.type, memory.scope,
          memory.summary || '', memory.tags
        );
        return { data: result };
      } finally {
        await session.close();
      }
    });

    // --- Graph stats ---
    app.get('/api/graph/stats', async () => {
      const session = getSession();
      try {
        const stats = await getGraphStats(session);
        return { data: stats };
      } finally {
        await session.close();
      }
    });

    // --- Bipartite memory↔entity edges (visualizer) ---
    const GraphEdgesQuery = z.object({
      min: z.coerce.number().int().min(1).max(1000).default(2),
      max: z.coerce.number().int().min(1).max(10000).default(50),
      scope: z.string().optional(),
      type: MemoryTypeEnum.optional(),
      entity_types: z.string().optional(), // comma-separated allowlist
    });

    app.get('/api/graph/edges', async (request) => {
      const start = Date.now();
      const input = GraphEdgesQuery.parse(request.query);
      if (input.min > input.max) {
        return { error: 'min must be <= max' };
      }
      const entityTypes = input.entity_types
        ? input.entity_types.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;

      const session = getSession();
      try {
        const graph = await getBipartiteGraph(session, {
          min: input.min,
          max: input.max,
          scope: input.scope,
          type: input.type,
          entityTypes,
        });
        return {
          data: graph,
          meta: {
            duration_ms: Date.now() - start,
            entity_count: graph.entities.length,
            link_count: graph.links.length,
            applied: { min: input.min, max: input.max, scope: input.scope ?? null, type: input.type ?? null, entity_types: entityTypes ?? null },
          },
        };
      } finally {
        await session.close();
      }
    });
  }

  // ========== Redis Context Endpoints (Phase 3) ==========

  if (config.redis.enabled && memoryCache) {
    // --- Set context ---
    app.put('/api/context', { preHandler: [requireAdminKey] }, async (request) => {
      const input = z.object({
        key: z.string().min(1),
        value: z.string(),
        ttl: z.number().int().min(1).optional(),
      }).parse(request.body);

      await memoryCache.setContext(input.key, input.value, input.ttl);
      return { data: { key: input.key, ttl: input.ttl || config.redis.ttl } };
    });

    // --- Get context ---
    app.get('/api/context/:key', async (request, reply) => {
      const { key } = request.params as { key: string };
      const value = await memoryCache.getContext(key);
      if (value === null) {
        reply.status(404);
        return { error: 'Context key not found' };
      }
      return { data: { key, value, ttl: config.redis.ttl } };
    });

    // --- List context keys ---
    app.get('/api/context', async (request) => {
      const { pattern } = request.query as { pattern?: string };
      const keys = await memoryCache.listContextKeys(pattern);
      return { data: { keys } };
    });

    // --- Delete context ---
    app.delete('/api/context/:key', { preHandler: [requireAdminKey] }, async (request) => {
      const { key } = request.params as { key: string };
      await memoryCache.deleteContext(key);
      return { data: { deleted: key } };
    });
  }

  // ========== MinIO Artifact Endpoints (Phase 4) ==========

  if (config.minio.enabled) {
    // --- Store artifact ---
    app.post('/api/artifacts', { preHandler: [requireAdminKey] }, async (request) => {
      const start = Date.now();
      const input = z.object({
        memory_id: z.number().int(),
        filename: z.string().min(1),
        content_base64: z.string().min(1),
        content_type: z.string().default('application/octet-stream'),
      }).parse(request.body);

      const content = Buffer.from(input.content_base64, 'base64');
      const metadata = await storeArtifact(input.memory_id, input.filename, content, input.content_type);
      return { data: metadata, meta: { duration_ms: Date.now() - start } };
    });

    // --- List artifacts by memory ---
    app.get('/api/artifacts', async (request) => {
      const { memory_id } = request.query as { memory_id?: string };
      if (!memory_id) return { data: [] };
      const artifacts = await listArtifacts(parseInt(memory_id, 10));
      return { data: artifacts };
    });

    // --- Get artifact by key ---
    app.get('/api/artifacts/:key', async (request, reply) => {
      const { key } = request.params as { key: string };
      const result = await getArtifact(decodeURIComponent(key));
      if (!result) {
        reply.status(404);
        return { error: 'Artifact not found' };
      }
      return {
        data: {
          ...result.metadata,
          content_base64: result.content.toString('base64'),
        },
      };
    });

    // --- Get presigned URL ---
    app.get('/api/artifacts/url', async (request) => {
      const { key } = request.query as { key: string };
      const url = await getArtifactUrl(key);
      return { data: { url, expires_in: 3600 } };
    });

    // --- Delete artifact ---
    app.delete('/api/artifacts/:key', { preHandler: [requireAdminKey] }, async (request) => {
      const { key } = request.params as { key: string };
      await deleteArtifact(decodeURIComponent(key));
      return { data: { deleted: key } };
    });

    // --- Storage stats ---
    app.get('/api/storage/stats', async () => {
      const stats = await getStorageStats();
      return { data: stats };
    });
  }

  // ========== Auto-Discovery Endpoints ==========

  if (config.discovery.ingestionEnabled && observationStore) {
    // Observation Zod schemas
    const ObservationInputSchema = z.object({
      idempotency_key: z.string().optional(),
      session_id: z.string().min(1),
      project_scope: z.string().min(1),
      tool_name: z.string().min(1),
      event_type: z.enum(['tool_start', 'tool_complete', 'tool_failed']).optional(),
      input_summary: z.string().max(config.discovery.maxInputSize).nullable().optional().transform(v => v ?? undefined),
      output_summary: z.string().max(config.discovery.maxErrorOutputSize).nullable().optional().transform(v => v ?? undefined),
      metadata: z.record(z.unknown()).nullable().optional().transform(v => v ?? undefined),
    });

    const ObservationBatchSchema = z.object({
      observations: z.array(ObservationInputSchema).min(1).max(100),
    });

    const ObservationCompleteSchema = z.object({
      output_summary: z.string().max(config.discovery.maxErrorOutputSize).nullable().optional().transform(v => v ?? undefined),
      status: z.enum(['completed', 'failed']),
      duration_ms: z.number().int().optional(),
    });

    // API key authentication preHandler
    const requireApiKey = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!config.discovery.apiKey) return; // No key configured = open (dev mode)
      const apiKey = request.headers['x-api-key'];
      if (apiKey !== config.discovery.apiKey) {
        reply.status(401).send({ error: 'Invalid or missing API key' });
      }
    };

    // Server-side secret scrubbing preHandler
    const scrubObservationBody = async (request: FastifyRequest) => {
      const body = request.body as Record<string, unknown>;
      if (body) {
        // metadata is JSON-stringified into a text column and never passes through
        // scrubSecrets, so it needs the NUL strip applied directly (a NUL anywhere
        // in the row 500s the insert and head-of-line blocks the hook's flush queue).
        if (body.metadata) body.metadata = stripUnstorableCharsDeep(body.metadata);
        if (typeof body.input_summary === 'string') {
          body.input_summary = scrubSecrets(body.input_summary);
          body.input_summary = truncate(body.input_summary as string, config.discovery.maxInputSize);
        }
        if (typeof body.output_summary === 'string') {
          // Check denylist for output suppression
          if (shouldSuppressOutput(
            (body.tool_name as string) ?? '',
            body.input_summary as string
          )) {
            body.output_summary = '[SUPPRESSED]';
          } else {
            const isError = (body.event_type as string) === 'tool_failed';
            const outputCap = isError ? config.discovery.maxErrorOutputSize : config.discovery.maxOutputSize;
            body.output_summary = scrubSecrets(body.output_summary);
            body.output_summary = truncate(body.output_summary as string, outputCap);
          }
        }
        // Scrub batch observations
        if (Array.isArray((body as Record<string, unknown>).observations)) {
          for (const obs of (body as Record<string, unknown[]>).observations) {
            const o = obs as Record<string, unknown>;
            if (o.metadata) o.metadata = stripUnstorableCharsDeep(o.metadata);
            if (typeof o.input_summary === 'string') {
              o.input_summary = scrubSecrets(o.input_summary);
              o.input_summary = truncate(o.input_summary as string, config.discovery.maxInputSize);
            }
            if (typeof o.output_summary === 'string') {
              if (shouldSuppressOutput((o.tool_name as string) ?? '', o.input_summary as string)) {
                o.output_summary = '[SUPPRESSED]';
              } else {
                const isError = (o.event_type as string) === 'tool_failed';
                const outputCap = isError ? config.discovery.maxErrorOutputSize : config.discovery.maxOutputSize;
                o.output_summary = scrubSecrets(o.output_summary);
                o.output_summary = truncate(o.output_summary as string, outputCap);
              }
            }
          }
        }
      }
    };

    // Server-side secret scrubbing for the completion PATCH. Its body carries
    // only output_summary (not tool_name/input_summary), so recover the started
    // observation's tool/input to keep the .env/ssh suppression denylist working.
    // Fail-safe: a fetch error scrubs secrets + caps length WITHOUT suppression,
    // never skips scrubbing.
    const scrubPatchObservationBody = async (request: FastifyRequest) => {
      const body = request.body as Record<string, unknown> | undefined;
      if (!body) return;
      if (body.metadata) body.metadata = stripUnstorableCharsDeep(body.metadata);
      if (typeof body.output_summary !== 'string') return;
      let toolName = '';
      let inputSummary: string | null = null;
      const { id } = request.params as { id: string };
      const obsId = parseInt(id, 10);
      if (!Number.isNaN(obsId)) {
        try {
          const [prior] = await observationStore.getObservationsSince(obsId - 1, undefined, 1);
          if (prior && prior.id === obsId) {
            toolName = prior.tool_name ?? '';
            inputSummary = prior.input_summary ?? null;
          }
        } catch {
          // fall through — scrub without suppression
        }
      }
      if (shouldSuppressOutput(toolName, inputSummary)) {
        body.output_summary = '[SUPPRESSED]';
      } else {
        const isError = (body.status as string) === 'failed';
        const outputCap = isError ? config.discovery.maxErrorOutputSize : config.discovery.maxOutputSize;
        body.output_summary = truncate(scrubSecrets(body.output_summary), outputCap);
      }
    };

    // --- Store observation ---
    app.post('/api/observations', {
      preHandler: [requireApiKey, scrubObservationBody],
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const input = ObservationInputSchema.parse(request.body);
      const obs = await observationStore.storeObservation(input);
      discoveryScheduler?.incrementCounter();
      observationBus?.publish(obs);
      reply.status(201);
      return { data: obs };
    });

    // --- Batch store observations ---
    // Explicit bodyLimit (T10): the global Fastify bodyLimit
    // (config.search.maxContentSize * 2 ≈ 100KB) is sized for single-memory
    // POSTs and is far too small for a full observation batch — up to 100
    // observations, each carrying input_summary (≤maxInputSize) +
    // output_summary (≤maxErrorOutputSize) + metadata. A legitimately full
    // batch (~1.1MB worst case) was being rejected with
    // FST_ERR_CTP_BODY_TOO_LARGE (HTTP 413) and silently dropped, spamming the
    // log. Cap explicitly at 2MB — accommodates the schema's worst case
    // (100 × ~11KB) with headroom while still bounding a runaway client. The
    // observe hook (scripts/hooks/kopeng-observe.js) also chunks its flush by a
    // smaller byte budget so it never relies on the server's outer cap.
    app.post('/api/observations/batch', {
      bodyLimit: 2 * 1024 * 1024,
      preHandler: [requireApiKey, scrubObservationBody],
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const input = ObservationBatchSchema.parse(request.body);
      const results = await observationStore.storeObservationBatch(input.observations);
      for (const obs of results) {
        discoveryScheduler?.incrementCounter();
        observationBus?.publish(obs);
      }
      reply.status(201);
      return { data: results, meta: { count: results.length } };
    });

    // --- Complete observation ---
    app.patch('/api/observations/:id', {
      preHandler: [requireApiKey, scrubPatchObservationBody],
    }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const obsId = parseInt(id, 10);
      if (isNaN(obsId)) { reply.status(400); return { error: 'Invalid observation ID' }; }
      const input = ObservationCompleteSchema.parse(request.body);
      const obs = await observationStore.completeObservation(obsId, input);
      if (!obs) {
        reply.status(404);
        return { error: 'Observation not found or already completed' };
      }
      observationBus?.publish(obs);
      return { data: obs };
    });

    // --- SSE stream of live observation events ---
    // Open-by-default (no auth gate even when API key is set) so the local
    // viz at port 7700 can subscribe without juggling headers. The stream
    // carries only post-scrub observation rows that are already public on
    // GET /api/observations/stats and would be exposed on a future list
    // endpoint anyway.
    if (observationBus) {
      app.get('/api/observations/stream', async (request, reply) => {
        // Tell Fastify we're taking over the raw socket — Fastify won't
        // send its own response or run the onSend hook.
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          // Disable proxy buffering (nginx, Cloud Run, etc.).
          'X-Accel-Buffering': 'no',
        });
        // Initial frame so EventSource transitions to OPEN immediately and
        // the client can detect the connection is live.
        raw.write(`: connected ${new Date().toISOString()}\n\n`);

        let dropped = 0;
        const onEvent = (evt: ObservationEvent) => {
          // Drop-on-slow-consumer: if the socket buffer is full, skip this
          // event rather than queueing memory. A counter on the comment
          // heartbeat lets the client surface a "lagging" indicator.
          if (raw.writableNeedDrain || raw.destroyed) {
            dropped++;
            return;
          }
          const payload = JSON.stringify({
            kind: evt.kind,
            seq: evt.seq,
            ts: evt.ts,
            observation: evt.observation,
          });
          raw.write(`id: ${evt.seq}\nevent: observation\ndata: ${payload}\n\n`);
        };
        const unsubscribe = observationBus.subscribe(onEvent);

        // 15s heartbeat keeps intermediaries from closing idle connections
        // and lets the client see drop counters even when no events flow.
        const heartbeat = setInterval(() => {
          if (raw.destroyed) return;
          raw.write(`: hb ${Date.now()}${dropped > 0 ? ` dropped=${dropped}` : ''}\n\n`);
        }, 15_000);

        const cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
          if (dropped > 0) {
            logger.warn(`SSE consumer dropped ${dropped} events (slow consumer)`);
          }
        };
        request.raw.on('close', cleanup);
        request.raw.on('error', cleanup);
      });
    }

    // --- Observation stats ---
    app.get('/api/observations/stats', {
      preHandler: [requireApiKey],
    }, async (request) => {
      const { project_scope } = request.query as { project_scope?: string };
      const stats = await observationStore.getObservationStats(project_scope);
      return { data: stats };
    });

    // --- Replay: list recent sessions ---
    // Backs the session-picker dropdown in the viz replay tab. Public — same
    // threat model as /api/observations/stream: observation rows are already
    // post-scrub and surfaced live to anyone on the local network.
    app.get('/api/observations/sessions', async (request) => {
      const { limit } = request.query as { limit?: string };
      const parsed = Math.max(1, Math.min(200, parseInt(limit ?? '50', 10) || 50));
      const sessions = await observationStore.listSessions(parsed);
      return { data: sessions, meta: { limit: parsed, count: sessions.length } };
    });

    // --- Replay: get all observations for a session ---
    // One-shot fetch of a session's full event timeline. The viz holds the
    // array in memory and advances through it with a setTimeout loop — no SSE.
    // limit defaults to 5000 (large but bounded — sessions rarely exceed it).
    app.get('/api/observations/by-session', async (request, reply) => {
      const { session_id, limit } = request.query as { session_id?: string; limit?: string };
      if (!session_id) {
        reply.status(400);
        return { error: 'session_id query parameter is required' };
      }
      const parsed = Math.max(1, Math.min(20000, parseInt(limit ?? '5000', 10) || 5000));
      const observations = await observationStore.getObservationsBySession(session_id, parsed);
      return { data: observations, meta: { session_id, limit: parsed, count: observations.length } };
    });
  }

  // --- Trigger discovery (requires scheduler) ---
  if (config.discovery.detectionEnabled && observationStore && discoveryScheduler) {
    app.post('/api/discover', { preHandler: [requireAdminKey] }, async () => {
      const start = Date.now();
      const result = await discoveryScheduler.triggerNow();
      return {
        data: result,
        meta: { duration_ms: Date.now() - start },
      };
    });
  }

  // --- Dreaming: manual trigger (D0.6) ---
  // Runs an empty-diff dream pass synchronously and returns its outcome. `dry_run`
  // computes + logs without writing; a duplicate window `collapsed`s. Gated on the
  // dream runner being wired (DREAMING_ENABLED + dream store present).
  if (dreamRunner) {
    app.post('/api/dreams/trigger', { preHandler: [requireAdminKey] }, async (request) => {
      const { reason, dry_run, window_key, mode } = TriggerDreamSchema.parse(request.body ?? {});
      const result = await dreamRunner({ trigger: 'manual', reason, dryRun: dry_run, windowKey: window_key, mode });
      return { data: result };
    });
  }

  // --- Dreaming: review/apply surface (D1.3) ---
  // Gated on the dream store (always constructed on both backends), not on
  // DREAMING_ENABLED — pending diffs stay reviewable and rollbacks possible
  // even when the scheduler is off.
  if (dreamStore) {
    // embedText (D2.2): operator-accepted conditional entries create the branch
    // encoding as a new memory, which needs a fresh embedding (invariant #10).
    const applyDeps = { memoryStore: queries, dreamStore, vectorIndex: embeddingIndex, embedText: embedWithModel };
    const parseDiff = (raw: string | null): DreamDiff =>
      raw ? (JSON.parse(raw) as DreamDiff) : { entries: [] };

    // --- List dreams awaiting review ---
    app.get('/api/dreams/pending', async (request) => {
      const { limit } = request.query as { limit?: string };
      const parsed = Math.max(1, Math.min(100, parseInt(limit ?? '20', 10) || 20));
      const dreams = await dreamStore.listPendingDreams(parsed);
      return {
        data: dreams.map(d => {
          const entries = parseDiff(d.output_diff).entries ?? [];
          return {
            id: d.id,
            window_key: d.window_key,
            scope: d.scope,
            mode: d.mode,
            trigger_source: d.trigger_source,
            acceptance_status: d.acceptance_status,
            started_at: d.started_at,
            memories_examined: d.memories_examined,
            changes_auto_applied: d.changes_auto_applied,
            pending_entries: entries.filter(e => !e.resolution).length,
            entries_total: entries.length,
          };
        }),
        meta: { count: dreams.length, limit: parsed },
      };
    });

    // --- Human-readable diff for one dream ---
    // Member reads here are review plumbing, deliberately NOT reinforcement
    // surfacing points (D1.1) — reinforcing dup/decay candidates from their own
    // review would reset the decay clocks the diff is reporting on.
    app.get('/api/dreams/:id/diff', async (request, reply) => {
      const { id } = request.params as { id: string };
      const dreamId = parseInt(id, 10);
      if (isNaN(dreamId)) { reply.status(400); return { error: 'Invalid dream ID' }; }
      const dream = await dreamStore.getDream(dreamId);
      if (!dream) {
        reply.status(404);
        return { error: 'Dream not found' };
      }
      const diffEntries = parseDiff(dream.output_diff).entries ?? [];

      const entries = [];
      for (let i = 0; i < diffEntries.length; i++) {
        const entry = diffEntries[i];
        const members = [];
        for (const memberId of entry.memory_ids) {
          const mem = await queries.get(memberId);
          if (!mem) {
            members.push({ id: memberId, missing: true });
            continue;
          }
          const meta = parseMetadata(mem.metadata);
          members.push({
            id: mem.id,
            type: mem.type,
            scope: mem.scope,
            confidence: mem.confidence,
            observation_count: mem.observation_count,
            last_seen: mem.last_seen,
            is_archived: !!mem.is_archived,
            tags: mem.tags,
            excerpt: mem.content.length > 240 ? `${mem.content.slice(0, 240)}…` : mem.content,
            evidence_count: Array.isArray(meta.evidence_snapshot) ? meta.evidence_snapshot.length : 0,
          });
        }

        // Confidence delta: kept memory vs the strongest memory being archived.
        const after = entry.after as { keep_id?: unknown; archive_ids?: unknown } | undefined;
        let confidenceDelta: number | null = null;
        if (after && typeof after.keep_id === 'number' && Array.isArray(after.archive_ids)) {
          const keep = members.find(m => m.id === after.keep_id && !('missing' in m));
          const archived = members.filter(m => (after.archive_ids as number[]).includes(m.id) && !('missing' in m));
          if (keep && archived.length > 0) {
            const cs = archived.map(m => (m as { confidence: number }).confidence);
            confidenceDelta = (keep as { confidence: number }).confidence - Math.max(...cs);
          }
        }

        entries.push({
          index: i,
          change_class: entry.change_class,
          tier: entry.tier,
          resolution: entry.resolution ?? 'pending',
          resolved_at: entry.resolved_at ?? null,
          rationale: entry.rationale,
          proposal: entry.after ?? null,
          confidence_delta: confidenceDelta,
          members,
          impact: describeDreamImpact(entry.change_class),
        });
      }

      return {
        data: {
          dream: {
            id: dream.id,
            window_key: dream.window_key,
            scope: dream.scope,
            mode: dream.mode,
            trigger_source: dream.trigger_source,
            status: dream.status,
            acceptance_status: dream.acceptance_status,
            started_at: dream.started_at,
            memories_examined: dream.memories_examined,
            changes_auto_applied: dream.changes_auto_applied,
            changes_queued: dream.changes_queued,
          },
          entries,
        },
      };
    });

    // --- Resolve queued entries (accept / reject / partial via entry_indices) ---
    app.post('/api/dreams/:id/resolve', { preHandler: [requireAdminKey] }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const dreamId = parseInt(id, 10);
      if (isNaN(dreamId)) { reply.status(400); return { error: 'Invalid dream ID' }; }
      const input = ResolveDreamSchema.parse(request.body);
      const dream = await dreamStore.getDream(dreamId);
      if (!dream) {
        reply.status(404);
        return { error: 'Dream not found' };
      }
      if (dream.status !== 'completed') {
        reply.status(409);
        return { error: `Dream is '${dream.status}' — only completed dreams can be resolved` };
      }
      const diffEntries = parseDiff(dream.output_diff).entries ?? [];
      if (diffEntries.length === 0) {
        reply.status(409);
        return { error: 'Dream has no diff entries to resolve' };
      }

      const nowIso = new Date().toISOString();
      if (input.action === 'reject') {
        // Reject touches only the dream row — the memory store stays untouched.
        const result = await resolveDream(applyDeps, dream, 'reject', input.entry_indices, nowIso);
        return { data: result };
      }

      // Accept mutates memories — it must hold the consolidation lock so a
      // mid-flight dream/discovery pass can't step on the same rows.
      // R9: unique per-request holder — two concurrent resolves must not
      // co-acquire via same-holder re-entry (lost-update on entry resolutions).
      const lock = new ConsolidationLockManager({ store: dreamStore, holder: uniqueHolder('dream-resolve') });
      const { acquired, result } = await lock.withLock(() =>
        resolveDream(applyDeps, dream, 'accept', input.entry_indices, nowIso));
      if (!acquired) {
        reply.status(423);
        return { error: 'Consolidation lock held elsewhere — retry shortly' };
      }
      return { data: result };
    });

    // --- Revision history for a memory ---
    app.get('/api/memories/:id/revisions', async (request, reply) => {
      const { id } = request.params as { id: string };
      const memId = parseInt(id, 10);
      if (isNaN(memId)) { reply.status(400); return { error: 'Invalid memory ID' }; }
      const revisions = await dreamStore.listRevisions(memId);
      return { data: revisions, meta: { count: revisions.length } };
    });

    // --- Rollback: restore a revision snapshot over the live row ---
    // Restores content + embedding + tags (the embedding is stored in the
    // revision, so content and vector stay consistent); unarchives if the apply
    // action archived the row; re-syncs the vector index.
    app.post('/api/memories/:id/rollback', { preHandler: [requireAdminKey] }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const memoryId = parseInt(id, 10);
      if (isNaN(memoryId)) { reply.status(400); return { error: 'Invalid memory ID' }; }
      const input = RollbackSchema.parse(request.body ?? {});

      const lock = new ConsolidationLockManager({ store: dreamStore, holder: uniqueHolder('dream-rollback') }); // R9

      const { acquired, result } = await lock.withLock(() =>
        rollbackMemory(applyDeps, memoryId, input.revision));
      if (!acquired) {
        reply.status(423);
        return { error: 'Consolidation lock held elsewhere — retry shortly' };
      }
      if (!result) {
        reply.status(404);
        return { error: 'No such memory revision' };
      }
      const memory = await queries.get(memoryId);
      return { data: { ...result, memory } };
    });
  }

  // --- Operator config (D1.3) ---
  // Exposes the auto_accept_* knobs (seeded OFF — GATE 1 governs the flip),
  // quiet hours, idle threshold, and the reasoner provider.
  if (operatorConfigStore) {
    app.get('/api/operator-config', async (_request, reply) => {
      const cfg = await operatorConfigStore.getConfig();
      if (!cfg) {
        reply.status(404);
        return { error: 'operator_config not seeded' };
      }
      return { data: cfg };
    });

    // Serializes operator-config PATCHes so the server-side `config`-blob merge
    // below is atomic w.r.t. other concurrent PATCHes: two writers to disjoint
    // keys in the shared JSON blob must BOTH persist (no read-merge-write race).
    // Process-local, per-app; a rejected run never wedges the queue.
    let configPatchChain: Promise<unknown> = Promise.resolve();

    app.patch('/api/operator-config', { preHandler: [requireAdminKey] }, async (request, reply) => {
      const input = OperatorConfigPatchSchema.parse(request.body);
      if (Object.keys(input).length === 0) {
        reply.status(400);
        return { error: 'Empty patch — provide at least one field' };
      }
      // T26 — SERVER-SIDE MERGE for the `config` JSON blob. A PATCH MERGES the
      // provided `config` keys into the stored blob instead of replacing it, so
      // a viz/MCP write to one key (e.g. dream_whole_corpus_cadence) can no
      // longer clobber an engine cursor write (dream_window_cursor /
      // dream_whole_corpus_cursor) that lives in the same blob — the old client
      // read-merge-write was a TOCTOU against those cursor writes.
      //   Merge rule (shallow, top-level keys):
      //     - an explicit `null` value DELETES that key,
      //     - any other value SETS it,
      //     - keys absent from the patch are left untouched.
      //   Top-level columns (timezone, idle_minutes, auto_accept_*, …) keep
      //   their prior replace semantics — only the `config` blob is merged.
      // The read → merge → write is serialized via configPatchChain so two
      // concurrent PATCHes to different blob keys cannot clobber each other.
      const run = configPatchChain.then(async () => {
        const { config: configPatch, ...rest } = input;
        let patch: Record<string, unknown> = rest;
        if (configPatch !== undefined) {
          const current = await operatorConfigStore.getConfig('default');
          let blob: Record<string, unknown>;
          try {
            const parsed = JSON.parse(current?.config ?? '{}');
            blob = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
              ? parsed as Record<string, unknown>
              : {}; // non-object stored blob: rebuild from the patch
          } catch {
            blob = {}; // corrupt stored blob: rebuild from the patch rather than 500
          }
          for (const [key, value] of Object.entries(configPatch)) {
            if (value === null) delete blob[key];
            else blob[key] = value;
          }
          patch = { ...rest, config: JSON.stringify(blob) };
        }
        return operatorConfigStore.updateConfig('default', patch);
      });
      // Keep the chain alive even if this run rejects (one failure must not
      // wedge later PATCHes); the awaited `run` still surfaces the error here.
      configPatchChain = run.catch(() => {});
      const cfg = await run;
      return { data: cfg };
    });
  }

  // --- Discovery listing + maintenance (requires observation store only) ---
  if (config.discovery.ingestionEnabled && observationStore) {
    // --- List discoveries ---
    app.get('/api/discoveries', async (request) => {
      const { limit, cursor } = request.query as { limit?: string; cursor?: string };
      const { memories, has_more } = await queries.list({
        type: 'discovery' as MemoryType,
        limit: Math.min(parseInt(limit || '20', 10), 100),
        cursor: cursor ? parseInt(cursor, 10) : undefined,
        include_archived: false,
      });

      return {
        data: memories,
        meta: { has_more, cursor: memories.length > 0 ? memories[memories.length - 1].id : undefined },
      };
    });

    // --- Discovery runs list ---
    app.get('/api/discoveries/runs', async (request) => {
      const { project_scope, limit } = request.query as { project_scope?: string; limit?: string };
      const runs = await observationStore.listDiscoveryRuns(project_scope, parseInt(limit || '20', 10));
      return { data: runs };
    });

    // --- Admin: Discovery maintenance ---
    app.post('/api/admin/discovery/maintain', { preHandler: [requireAdminKey] }, async () => {
      const result = await runDiscoveryMaintenance(observationStore, queries);
      return { data: result };
    });
  }

  // ========== Admin: Promotion Pipeline (Phase 5) ==========

  app.post('/api/admin/promote', { preHandler: [requireAdminKey] }, async (request, reply) => {
    const start = Date.now();
    const input = z.object({
      archive_threshold: z.number().min(0).max(1).default(0.1),
      similarity_threshold: z.number().min(0).max(1).default(0.95),
      dry_run: z.boolean().default(false),
      // GATE 1: decay archival is opt-in even on manual runs (default OFF — a
      // non-dry run reports candidates but mutates nothing without it).
      archive_decayed: z.boolean().default(false),
      // T30.3: run the audited auto-crystallization pass on demand (default OFF).
      // A dry run reports candidates without mutating (crystallizeEligible
      // withholds); a non-dry run promotes durable memories to 0.97 under the
      // consolidation lock, snapshot-first + reversible. Lets the operator preview
      // + supervise crystallization instead of waiting for the nightly flag.
      crystallize: z.boolean().default(false),
      // RETIRED at GATE 1: the promotion dup-archiver once collapsed template
      // memories about different referents; duplicate collapse is owned by the
      // dream apply path. Rejected loudly rather than silently ignored.
      archive_duplicates: z.boolean().default(false),
    }).parse(request.body || {});

    if (input.archive_duplicates) {
      reply.status(400);
      return { error: 'archive_duplicates is retired (GATE 1): duplicate collapse flows through the dream apply path (scope-tiered, anchor-checked, audited). Promotion only reports duplicate candidates.' };
    }

    // Import promotion engine dynamically to avoid circular deps
    const { runPromotion } = await import('../promotion/promotion-engine.js');

    // Get the raw database connection for decay scoring
    let pool: import('pg').Pool | null = null;
    let sqliteDb: import('better-sqlite3').Database | null = null;
    if (config.database.type === 'postgres') {
      const { getPool } = await import('../database/postgres.js');
      pool = getPool();
    } else {
      const { getDatabase } = await import('../database/database.js');
      sqliteDb = getDatabase();
    }

    const promote = () => runPromotion(queries, embeddingIndex, pool, sqliteDb, {
      archiveThreshold: input.archive_threshold,
      similarityThreshold: input.similarity_threshold,
      dryRun: input.dry_run,
      archiveDecayed: input.archive_decayed,
      // T30.3: on-demand crystallization (dry-run reports, non-dry applies audited).
      crystallize: input.crystallize,
      // R14: the audited decay archive (snapshot + dream_audit_log + rollback)
      // needs the dream store. Without it a non-dry decay archive is withheld.
      dreamStore: dreamStore ?? null,
    });

    // R10: a non-dry manual promote can write (when archive_decayed is on) —
    // it must hold the consolidation lock so it can't interleave with a dream
    // apply or the nightly chain. Dry runs are read-only and stay lock-free.
    if (!input.dry_run && dreamStore) {
      const lock = new ConsolidationLockManager({ store: dreamStore, holder: uniqueHolder('promotion-manual') });
      const { acquired, result } = await lock.withLock(promote);
      if (!acquired) {
        reply.status(423);
        return { error: 'Consolidation lock held elsewhere — retry shortly' };
      }
      return { data: result, meta: { duration_ms: Date.now() - start } };
    }

    const result = await promote();
    return {
      data: result,
      meta: { duration_ms: Date.now() - start },
    };
  });

  // ========== Ops Endpoints (read-only operational visibility) ==========
  // Pattern: thin JSON snapshots polled by the viz ops tab every 5–10s.
  // Public — same threat model as /api/stats. Treat outputs as post-scrub.

  // --- Discovery cursor lag ---
  // Returns the global watermark vs MAX(observations.id), plus a small window of
  // recent runs so the UI can sparkline the last hour of activity.
  app.get('/api/ops/discovery-status', async () => {
    if (!observationStore) {
      return { data: { enabled: false, watermark: 0, max_observation_id: 0, lag: 0, recent_runs: [], runs_last_hour: 0, last_observation_at: null } };
    }
    // T19: last_observation_at (reuses the R3 getLastObservationAt on both
    // backends) backs the viz "senses" age light — a silent feed goes visibly
    // stale instead of just parking on old numbers.
    const [watermark, maxId, recentRuns, lastObservationAt] = await Promise.all([
      observationStore.getLastWatermark(),
      observationStore.getMaxObservationId(),
      observationStore.listDiscoveryRuns(undefined, 50),
      observationStore.getLastObservationAt(),
    ]);
    const oneHourAgo = Date.now() - 3_600_000;
    const runsLastHour = recentRuns.filter(r => {
      if (!r.completed_at) return false;
      return new Date(r.completed_at).getTime() >= oneHourAgo;
    }).length;
    const lastRun = recentRuns[0] ?? null;
    return {
      data: {
        enabled: true,
        watermark,
        max_observation_id: maxId,
        lag: Math.max(0, maxId - watermark),
        runs_last_hour: runsLastHour,
        last_observation_at: lastObservationAt,
        last_run_at: lastRun?.completed_at ?? lastRun?.started_at ?? null,
        recent_runs: recentRuns.slice(0, 20).map(r => ({
          id: r.id,
          project_scope: r.project_scope,
          status: r.status,
          started_at: r.started_at,
          completed_at: r.completed_at,
          observations_analyzed: r.observations_analyzed,
          patterns_found: r.patterns_found,
          memories_created: r.memories_created,
          memories_reinforced: r.memories_reinforced,
        })),
      },
    };
  });

  // --- Reasoner liveness (T21) ---
  // Read-only status so an armed-but-dark reasoner can never be silent again:
  // armed flag (DREAM_REASONER_ENABLED), provider reachability (fail-soft probe),
  // resolved model, and last-classify-at. Degrades to a disarmed status when the
  // dreaming stack (and thus the status closure) isn't constructed.
  app.get('/api/ops/reasoner-status', async () => {
    if (!reasonerStatus) {
      return { data: { armed: false, provider: 'none', reachable: null, model: null, url: null, last_classify_at: null } };
    }
    return { data: await reasonerStatus() };
  });

  // --- Last promotion run ---
  app.get('/api/ops/last-promotion', async () => {
    const [last, recent] = await Promise.all([
      queries.getLastPromotionRun(),
      queries.listPromotionRuns(10),
    ]);
    return { data: { last, recent } };
  });

  // --- Confidence-tier distribution ---
  app.get('/api/ops/confidence-distribution', async () => {
    const rows = await queries.getConfidenceDistribution();
    // Roll up by tier for the overall totals; keep per-type for the stacked-bar render.
    const byTier: Record<string, number> = { noted: 0, pattern: 0, actionable: 0, confirmed: 0 };
    for (const r of rows) byTier[r.tier] = (byTier[r.tier] ?? 0) + r.count;
    return { data: { by_type: rows, by_tier: byTier } };
  });

  // --- Ops memoization ---
  // top-decaying and corpus-health recompute over the whole corpus per call
  // (full decay GROUP-BY / O(n^2) cosine scan) and the viz polls them every 30s.
  // A short in-process TTL turns repeated polls into cache hits; the stored
  // promise dedupes concurrent recomputes. Snapshot data — staleness ≤ TTL is fine.
  // Keys are client-controlled params, so bound the map: expired entries are
  // swept on write and the whole map resets if a caller manages to vary keys
  // faster than the TTL retires them (corpus-health quantizes `sample` too).
  const OPS_CACHE_TTL_MS = 60_000;
  const OPS_CACHE_MAX_KEYS = 128;
  const opsMemo = new Map<string, { at: number; value: Promise<unknown> }>();
  function memoizeOps<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = opsMemo.get(key);
    if (hit && now - hit.at < OPS_CACHE_TTL_MS) return hit.value as Promise<T>;
    for (const [k, v] of opsMemo) {
      if (now - v.at >= OPS_CACHE_TTL_MS) opsMemo.delete(k);
    }
    if (opsMemo.size >= OPS_CACHE_MAX_KEYS) opsMemo.clear();
    const value = compute().catch((err: unknown) => {
      opsMemo.delete(key); // never cache a failure
      throw err;
    });
    opsMemo.set(key, { at: now, value });
    return value;
  }

  // --- Top-decaying memories ---
  app.get('/api/ops/top-decaying', async (request) => {
    const limit = Math.max(1, Math.min(100, parseInt((request.query as { limit?: string }).limit ?? '20', 10) || 20));
    return memoizeOps(`top-decaying:${limit}`, async () => {
      const rows = await queries.getTopDecaying(limit);
      return { data: rows, meta: { limit, count: rows.length } };
    });
  });

  // --- Cache / dedup stats ---
  // v1: surface aggregated counters from the most recent N discovery_runs rather
  // than adding new in-memory instrumentation. The dedup ratio (reinforced /
  // (created + reinforced)) is a rough proxy for "how much new vs how much
  // reinforce" activity the engine is doing.
  app.get('/api/ops/cache-stats', async () => {
    if (!observationStore) {
      return { data: { enabled: false } };
    }
    const recent = await observationStore.listDiscoveryRuns(undefined, 100);
    const completed = recent.filter(r => r.status === 'completed');
    const totals = completed.reduce((acc, r) => {
      acc.observations_analyzed += r.observations_analyzed;
      acc.patterns_found += r.patterns_found;
      acc.memories_created += r.memories_created;
      acc.memories_reinforced += r.memories_reinforced;
      return acc;
    }, { observations_analyzed: 0, patterns_found: 0, memories_created: 0, memories_reinforced: 0 });
    const decisions = totals.memories_created + totals.memories_reinforced;
    const dedupRatio = decisions > 0 ? totals.memories_reinforced / decisions : 0;
    return {
      data: {
        enabled: true,
        sample_size: completed.length,
        totals,
        dedup_ratio: dedupRatio,
        note: 'Aggregated from the last 100 completed discovery runs. Resets implicitly as old runs age out of the window.',
      },
    };
  });

  // --- Dream history ---
  // Recent completed dream passes with per-pass change counts. Fills the gap that
  // only /api/dreams/pending existed: a chronological view of what dreaming did.
  // Completed-only by design (mirrors getLastCompletedDream semantics — this is a
  // record of what dreaming *changed*, not a pass-failure log). Failed passes are
  // intentionally excluded; surface them separately if pass-health is ever needed.
  app.get('/api/ops/dream-history', async (request) => {
    if (!dreamStore) {
      return { data: { enabled: false, dreams: [] } };
    }
    const q = DreamHistoryQuerySchema.parse(request.query);
    const dreams = await dreamStore.listRecentDreams(q.limit, q.offset);
    const rows = dreams.map(d => {
      // Derive change counts from the stored diff resolution (auto-applied/accepted/
      // rejected vs still-pending). Falls back to the dream's own counters.
      let proposed = 0, applied = 0, accepted = 0, rejected = 0, pending = 0;
      const byChangeClass: Record<string, number> = {};
      if (d.output_diff) {
        try {
          const diff = JSON.parse(d.output_diff) as DreamDiff;
          for (const e of diff.entries ?? []) {
            proposed++;
            byChangeClass[e.change_class] = (byChangeClass[e.change_class] ?? 0) + 1;
            if (e.resolution === 'auto_applied') applied++;
            else if (e.resolution === 'accepted') accepted++;
            else if (e.resolution === 'rejected') rejected++;
            else pending++;
          }
        } catch { /* malformed diff: leave counts at the column-derived fallback below */ }
      }
      return {
        id: d.id,
        scope: d.scope,
        mode: d.mode,
        trigger_source: d.trigger_source,
        window_key: d.window_key,
        status: d.status,
        acceptance_status: d.acceptance_status,
        started_at: d.started_at,
        completed_at: d.completed_at,
        duration_ms: d.duration_ms,
        memories_examined: d.memories_examined,
        changes: {
          proposed: proposed || (d.changes_auto_applied + d.changes_queued),
          auto_applied: applied || d.changes_auto_applied,
          accepted,
          rejected,
          pending: pending || d.changes_queued,
          by_change_class: byChangeClass,
        },
      };
    });
    return { data: { enabled: true, dreams: rows }, meta: { limit: q.limit, offset: q.offset, count: rows.length } };
  });

  // --- Corpus health snapshot ---
  // Point-in-time signals that dreaming keeps the corpus leaner/cleaner.
  // Cheap aggregates (count, mean confidence, contradiction-flagged) come straight
  // from SQL. The two derived signals — duplicate-pair count (cosine > threshold)
  // and decayed/at-risk count (memoryStrength < 0.2) — are computed over a BOUNDED
  // sample (default 2000 active rows, ascending id), like /api/ops/top-decaying's
  // on-demand compute. The dup scan is O(n^2) over the sample; the cap keeps it cheap.
  app.get('/api/ops/corpus-health', async (request) => {
    const q = CorpusHealthQuerySchema.parse(request.query);
    // Quantize the sample cap to 500-row buckets: caps the memo-key space at 20
    // and stops a caller from forcing a fresh O(n^2) scan per distinct value.
    const sample = Math.min(10000, Math.ceil(q.sample / 500) * 500);
    return memoizeOps(`corpus-health:${sample}`, () => computeCorpusHealth(sample));
  });

  async function computeCorpusHealth(sampleCap: number) {
    const [stats, sample] = await Promise.all([
      queries.getCorpusHealthStats(),
      queries.getCorpusHealthSample(sampleCap),
    ]);

    const now = new Date();
    let decayedAtRisk = 0;
    const vectors: { row: (typeof sample)[number]; vec: Float32Array }[] = [];
    for (const m of sample) {
      if (memoryStrength(m, now) < 0.2) decayedAtRisk++;
      if (m.embedding) vectors.push({ row: m, vec: bufferToEmbedding(m.embedding) });
    }

    // Pairwise cosine over the sampled embeddings — pairs at/above the deterministic
    // duplicate threshold, bucketed by what dreaming could actually do with each
    // (classifyDupPair — same predicates as the selector). Only `actionable` pairs
    // are dreaming's to collapse; anchored/cross-scope/condition-linked are
    // by-design exempt, so a nonzero total with zero dream proposals is healthy.
    // O(n^2) but bounded by the sample cap. Yield to the event loop between outer
    // rows: the full scan is ~1.3s of CPU on a 2000-row sample and must not stall
    // concurrent requests (the recall hook runs on a 3s budget).
    const duplicatePairs = { total: 0, actionable: 0, anchored: 0, cross_scope: 0, condition_linked: 0 };
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        if (cosineSimilarity(vectors[i].vec, vectors[j].vec) >= COSINE_DUPLICATE_THRESHOLD) {
          duplicatePairs.total++;
          duplicatePairs[classifyDupPair(vectors[i].row, vectors[j].row)]++;
        }
      }
      if (i % 16 === 15) await new Promise(resolve => setImmediate(resolve));
    }

    const sampled = sample.length < stats.active_count;
    return {
      data: {
        active_memory_count: stats.active_count,
        mean_confidence: stats.mean_confidence,
        contradiction_flagged_count: stats.contradiction_flagged_count,
        duplicate_pair_count: duplicatePairs.total,
        duplicate_pairs: duplicatePairs,
        decayed_at_risk_count: decayedAtRisk,
      },
      meta: {
        sample_size: sample.length,
        sampled,
        note: (sampled
          ? `Duplicate-pair and decayed-at-risk counts computed over the first ${sample.length} active memories (cap ${sampleCap}); they undercount the full corpus. `
          : 'Duplicate-pair and decayed-at-risk counts cover the full active corpus. ')
          + 'Only `actionable` duplicate pairs are dreaming\'s to collapse; anchored/cross-scope/condition-linked pairs are by-design exempt.',
      },
    };
  }

  // --- Static surfacing (C1.2 / T12) ---
  // Maps a natural-language prompt + optional project context → capped,
  // precision-filtered, class-labelled candidate tools / skills / conventions.
  // The hook (T16) is a thin client of this endpoint.
  app.post('/api/surface', async (request, reply) => {
    const start = Date.now();
    let input: z.infer<typeof SurfaceSchema>;
    try {
      input = SurfaceSchema.parse(request.body);
    } catch (err) {
      reply.status(400);
      return { error: 'Invalid request body', details: err instanceof Error ? err.message : String(err) };
    }

    // Resolve project scope: explicit project_scope wins; fall back to cwd basename.
    let projectScope: string | undefined = input.project_scope;
    if (!projectScope && input.cwd) {
      const basename = input.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop();
      if (basename) projectScope = `project:${basename}`;
    }

    const result = await surface(
      { queries, embeddingIndex },
      { prompt: input.prompt, projectScope, caps: input.caps },
    );

    return {
      data: result,
      meta: { duration_ms: Date.now() - start },
    };
  });
}
