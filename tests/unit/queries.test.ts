import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { MemoryQueries, computeContentHash, generateSummary } from '../../src/database/queries.js';
import { createTestDatabase, createTestMemory } from '../fixtures/test-helpers.js';

describe('computeContentHash', () => {
  it('should produce consistent SHA256 hashes', () => {
    const hash1 = computeContentHash('hello');
    const hash2 = computeContentHash('hello');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('should trim whitespace before hashing', () => {
    expect(computeContentHash('  hello  ')).toBe(computeContentHash('hello'));
  });

  it('should produce different hashes for different content', () => {
    expect(computeContentHash('hello')).not.toBe(computeContentHash('world'));
  });
});

describe('generateSummary', () => {
  it('should extract first sentence', () => {
    // Regex requires whitespace after the sentence-ending punctuation
    expect(generateSummary('First sentence. Second sentence.')).toBe('First sentence.');
  });

  it('should truncate long content without sentence boundary', () => {
    const long = 'a'.repeat(300);
    const summary = generateSummary(long);
    expect(summary.length).toBeLessThanOrEqual(203); // 200 + '...'
  });

  it('should handle short content', () => {
    expect(generateSummary('Short')).toBe('Short');
  });
});

describe('MemoryQueries', () => {
  let db: Database.Database;
  let queries: MemoryQueries;

  beforeEach(() => {
    const result = createTestDatabase();
    db = result.db;
    queries = result.queries;
  });

  afterEach(() => {
    db.close();
  });

  describe('store', () => {
    it('should store a memory and return id', async () => {
      const result = await queries.store(createTestMemory());
      expect(result.id).toBeGreaterThan(0);
      expect(result.deduplicated).toBe(false);
    });

    it('should deduplicate identical content', async () => {
      const mem = createTestMemory({ content: 'duplicate content' });
      const first = await queries.store(mem);
      const second = await queries.store(mem);
      expect(second.deduplicated).toBe(true);
      expect(second.id).toBe(first.id);
    });

    it('should store tags', async () => {
      const result = await queries.store(createTestMemory({ tags: ['tag1', 'tag2'] }));
      const memory = await queries.get(result.id);
      expect(memory?.tags).toEqual(expect.arrayContaining(['tag1', 'tag2']));
    });

    // T23 (decision D2): the store default confidence is 0.9, not 1.0.
    it('should default confidence to 0.9 when none is provided', async () => {
      const result = await queries.store(createTestMemory({ confidence: undefined }));
      const memory = await queries.get(result.id);
      expect(memory!.confidence).toBe(0.9);
    });

    it('should keep an explicit confidence of 1.0 (deliberate Hard Anchor)', async () => {
      const result = await queries.store(createTestMemory({ confidence: 1.0 }));
      const memory = await queries.get(result.id);
      expect(memory!.confidence).toBe(1.0);
    });

    it('should honor an explicit sub-default confidence', async () => {
      const result = await queries.store(createTestMemory({ confidence: 0.55 }));
      const memory = await queries.get(result.id);
      expect(memory!.confidence).toBe(0.55);
    });

    it('should default confidence to 0.9 for batch stores too', async () => {
      const { ids } = await queries.storeBatch([
        createTestMemory({ content: 'batch-a', confidence: undefined }),
        createTestMemory({ content: 'batch-b', confidence: 1.0 }),
      ]);
      const a = await queries.get(ids[0]);
      const b = await queries.get(ids[1]);
      expect(a!.confidence).toBe(0.9);
      expect(b!.confidence).toBe(1.0);
    });
  });

  describe('get', () => {
    it('should return null for non-existent id', async () => {
      expect(await queries.get(99999)).toBeNull();
    });

    it('should return memory with tags', async () => {
      const { id } = await queries.store(createTestMemory({ tags: ['test'] }));
      const memory = await queries.get(id);
      expect(memory).not.toBeNull();
      expect(memory!.content).toBe('Test memory content for unit testing');
      expect(memory!.tags).toContain('test');
    });
  });

  describe('update', () => {
    it('should update content and detect change', async () => {
      const { id } = await queries.store(createTestMemory());
      const result = await queries.update(id, {
        content: 'Updated content',
        type: 'reference',
        scope: 'global',
        metadata: '{}',
        tags: [],
      });
      expect(result.contentChanged).toBe(true);
      const memory = await queries.get(id);
      expect(memory!.content).toBe('Updated content');
    });

    it('should detect no change when content is same', async () => {
      const content = 'Same content';
      const { id } = await queries.store(createTestMemory({ content }));
      const result = await queries.update(id, {
        content,
        type: 'reference',
        scope: 'global',
        metadata: '{}',
        tags: [],
      });
      expect(result.contentChanged).toBe(false);
    });

    it('should throw for non-existent id', async () => {
      await expect(queries.update(99999, {
        content: 'x', type: 'reference', scope: 'global', metadata: '{}', tags: [],
      })).rejects.toThrow('Memory 99999 not found');
    });
  });

  describe('archive/unarchive', () => {
    it('should archive and unarchive a memory', async () => {
      const { id } = await queries.store(createTestMemory());
      expect(await queries.archive(id)).toBe(true);

      // Archived memories excluded from count
      const count = await queries.getCount();
      expect(count).toBe(0);

      expect(await queries.unarchive(id)).toBe(true);
      expect(await queries.getCount()).toBe(1);
    });

    it('should return false for non-existent id', async () => {
      expect(await queries.archive(99999)).toBe(false);
    });
  });

  describe('searchFts', () => {
    it('should find memories by keyword', async () => {
      await queries.store(createTestMemory({ content: 'PostgreSQL database migration' }));
      await queries.store(createTestMemory({ content: 'Redis cache layer' }));

      const results = await queries.searchFts('PostgreSQL', 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].rowid).toBeGreaterThan(0);
    });

    it('should return empty for no match', async () => {
      await queries.store(createTestMemory({ content: 'something else entirely' }));
      const results = await queries.searchFts('zzzznonexistent', 10);
      expect(results).toHaveLength(0);
    });
  });

  describe('list', () => {
    it('should list memories with pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await queries.store(createTestMemory({ content: `Memory ${i}` }));
      }
      const result = await queries.list({ limit: 3, include_archived: false });
      expect(result.memories).toHaveLength(3);
      expect(result.has_more).toBe(true);
    });

    it('should filter by type', async () => {
      await queries.store(createTestMemory({ type: 'user', content: 'user mem' }));
      await queries.store(createTestMemory({ type: 'feedback', content: 'feedback mem' }));
      const result = await queries.list({ type: 'user', limit: 10, include_archived: false });
      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].type).toBe('user');
    });

    it('should filter by scope', async () => {
      await queries.store(createTestMemory({ scope: 'project:foo', content: 'scoped mem' }));
      await queries.store(createTestMemory({ scope: 'global', content: 'global mem' }));
      const result = await queries.list({ scope: 'project:foo', limit: 10, include_archived: false });
      expect(result.memories).toHaveLength(1);
    });

    it('should filter by tags', async () => {
      await queries.store(createTestMemory({ tags: ['important'], content: 'tagged' }));
      await queries.store(createTestMemory({ tags: ['other'], content: 'other tagged' }));
      const result = await queries.list({ tags: ['important'], limit: 10, include_archived: false });
      expect(result.memories).toHaveLength(1);
    });

    it('lite omits the embedding but keeps content and tags', async () => {
      const stored = await queries.store(createTestMemory({ content: 'lite row', tags: ['viz'] }));
      const vec = new Float32Array([0.1, 0.2, 0.3]);
      await queries.setEmbedding(stored.id, Buffer.from(vec.buffer), 'test-model');

      const full = await queries.list({ limit: 10, include_archived: false });
      expect(full.memories[0].embedding).not.toBeNull();

      const lite = await queries.list({ limit: 10, include_archived: false, lite: true });
      expect(lite.memories[0].embedding).toBeNull();
      expect(lite.memories[0].content).toBe('lite row');
      expect(lite.memories[0].tags).toEqual(['viz']);
      expect(lite.has_more).toBe(false);
    });
  });

  describe('storeBatch', () => {
    it('should store multiple memories in a transaction', async () => {
      const items = [
        createTestMemory({ content: 'Batch item 1' }),
        createTestMemory({ content: 'Batch item 2' }),
        createTestMemory({ content: 'Batch item 3' }),
      ];
      const result = await queries.storeBatch(items);
      expect(result.ids).toHaveLength(3);
      expect(result.duplicates).toBe(0);
    });

    it('should count duplicates in batch', async () => {
      const mem = createTestMemory({ content: 'Duplicate batch item' });
      await queries.store(mem);
      const result = await queries.storeBatch([mem, createTestMemory({ content: 'New item' })]);
      expect(result.duplicates).toBe(1);
    });
  });

  describe('stats', () => {
    it('should return correct counts', async () => {
      await queries.store(createTestMemory({ type: 'user', content: 'user1' }));
      await queries.store(createTestMemory({ type: 'feedback', content: 'fb1' }));
      expect(await queries.getCount()).toBe(2);

      const typeStats = await queries.getTypeStats();
      expect(typeStats['user']).toBe(1);
      expect(typeStats['feedback']).toBe(1);
    });
  });

  describe('getFilteredIds', () => {
    it('should return filtered memory ids', async () => {
      await queries.store(createTestMemory({ type: 'user', content: 'u1' }));
      await queries.store(createTestMemory({ type: 'feedback', content: 'f1' }));
      const ids = await queries.getFilteredIds({ type: 'user', include_archived: false });
      expect(ids).toHaveLength(1);
    });
  });

  describe('setEmbedding', () => {
    it('should set embedding on a memory', async () => {
      const { id } = await queries.store(createTestMemory());
      const embedding = Buffer.from(new Float32Array(384).buffer);
      await queries.setEmbedding(id, embedding, 'test-model');

      const embeddings = await queries.loadAllEmbeddings();
      expect(embeddings).toHaveLength(1);
      expect(embeddings[0].id).toBe(id);
    });
  });
});
