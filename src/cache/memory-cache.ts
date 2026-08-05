import type Redis from 'ioredis';
import config from '../config/config.js';
import logger from '../utils/logger.js';

export class MemoryCache {
  private redis: Redis;
  private ttl: number;

  constructor(redis: Redis, ttl?: number) {
    this.redis = redis;
    this.ttl = ttl || config.redis.ttl;
  }

  async getMemory(id: number): Promise<string | null> {
    try {
      return await this.redis.get(`mem:${id}`);
    } catch (err) {
      logger.warn('Memory cache get failed:', err);
      return null;
    }
  }

  async setMemory(id: number, data: string): Promise<void> {
    try {
      await this.redis.setex(`mem:${id}`, this.ttl, data);
    } catch (err) {
      logger.warn('Memory cache set failed:', err);
    }
  }

  async invalidateMemory(id: number): Promise<void> {
    try {
      await this.redis.del(`mem:${id}`);
    } catch (err) {
      logger.warn('Memory cache invalidation failed:', err);
    }
  }

  async getContext(key: string): Promise<string | null> {
    try {
      return await this.redis.get(`ctx:${key}`);
    } catch (err) {
      logger.warn('Context get failed:', err);
      return null;
    }
  }

  async setContext(key: string, value: string, ttl?: number): Promise<void> {
    try {
      await this.redis.setex(`ctx:${key}`, ttl || this.ttl, value);
    } catch (err) {
      logger.warn('Context set failed:', err);
    }
  }

  async deleteContext(key: string): Promise<void> {
    try {
      await this.redis.del(`ctx:${key}`);
    } catch (err) {
      logger.warn('Context delete failed:', err);
    }
  }

  async listContextKeys(pattern?: string): Promise<string[]> {
    try {
      const keys = await this.redis.keys(`ctx:${pattern || '*'}`);
      return keys.map(k => k.replace(config.redis.keyPrefix, '').replace('ctx:', ''));
    } catch (err) {
      logger.warn('Context list failed:', err);
      return [];
    }
  }
}
