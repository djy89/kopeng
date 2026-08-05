import type Redis from 'ioredis';
import crypto from 'crypto';
import config from '../config/config.js';
import logger from '../utils/logger.js';

function searchCacheKey(query: string, mode: string, type?: string, scope?: string, tags?: string[]): string {
  const normalized = JSON.stringify({ query, mode, type, scope, tags: tags?.sort() });
  const hash = crypto.createHash('md5').update(normalized).digest('hex');
  return `search:${hash}`;
}

export class SearchCache {
  private redis: Redis;
  private ttl: number;

  constructor(redis: Redis, ttl?: number) {
    this.redis = redis;
    this.ttl = ttl || config.redis.ttl;
  }

  async get(query: string, mode: string, type?: string, scope?: string, tags?: string[]): Promise<string | null> {
    try {
      const key = searchCacheKey(query, mode, type, scope, tags);
      const cached = await this.redis.get(key);
      if (cached) {
        logger.debug(`Search cache hit: ${query.slice(0, 50)}`);
      }
      return cached;
    } catch (err) {
      logger.warn('Search cache get failed:', err);
      return null;
    }
  }

  async set(query: string, mode: string, type: string | undefined, scope: string | undefined, tags: string[] | undefined, results: string): Promise<void> {
    try {
      const key = searchCacheKey(query, mode, type, scope, tags);
      await this.redis.setex(key, this.ttl, results);
    } catch (err) {
      logger.warn('Search cache set failed:', err);
    }
  }

  async invalidate(): Promise<void> {
    try {
      const keys = await this.redis.keys('search:*');
      if (keys.length > 0) {
        await this.redis.del(...keys.map(k => k.replace(config.redis.keyPrefix, '')));
      }
      logger.info('Search cache invalidated');
    } catch (err) {
      logger.warn('Search cache invalidation failed:', err);
    }
  }
}
