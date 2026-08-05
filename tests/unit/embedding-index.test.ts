import { describe, it, expect, beforeEach } from 'vitest';
import { EmbeddingIndex } from '../../src/embeddings/index.js';

function createRandomEmbedding(dim: number = 384): Float32Array {
  const arr = new Float32Array(dim);
  for (let i = 0; i < dim; i++) arr[i] = Math.random() - 0.5;
  return arr;
}

function createEmbeddingBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

describe('EmbeddingIndex', () => {
  let index: EmbeddingIndex;

  beforeEach(() => {
    index = new EmbeddingIndex();
  });

  it('should not be ready initially', () => {
    expect(index.isReady).toBe(false);
    expect(index.size).toBe(0);
  });

  it('should load from database rows', async () => {
    const rows = [
      { id: 1, embedding: createEmbeddingBuffer(createRandomEmbedding()) },
      { id: 2, embedding: createEmbeddingBuffer(createRandomEmbedding()) },
    ];
    await index.loadFromDatabase(rows);
    expect(index.isReady).toBe(true);
    expect(index.size).toBe(2);
  });

  it('should add and remove vectors', async () => {
    await index.loadFromDatabase([]);
    await index.add(1, createRandomEmbedding());
    expect(index.size).toBe(1);
    await index.remove(1);
    expect(index.size).toBe(0);
  });

  it('should search and return sorted results', async () => {
    const target = createRandomEmbedding();
    await index.loadFromDatabase([]);
    await index.add(1, target);
    await index.add(2, createRandomEmbedding());
    await index.add(3, createRandomEmbedding());

    const results = await index.search(target, undefined, 3);
    expect(results).toHaveLength(3);
    // The exact match should have the highest score
    expect(results[0].id).toBe(1);
    expect(results[0].score).toBeCloseTo(1.0, 1);
  });

  it('should filter by candidate IDs', async () => {
    await index.loadFromDatabase([]);
    await index.add(1, createRandomEmbedding());
    await index.add(2, createRandomEmbedding());
    await index.add(3, createRandomEmbedding());

    const results = await index.search(createRandomEmbedding(), [1, 3], 10);
    expect(results).toHaveLength(2);
    expect(results.map(r => r.id)).not.toContain(2);
  });

  it('should handle zero vector query', async () => {
    await index.loadFromDatabase([]);
    await index.add(1, createRandomEmbedding());
    const zeroVec = new Float32Array(384);
    const results = await index.search(zeroVec);
    expect(results).toHaveLength(0);
  });
});
