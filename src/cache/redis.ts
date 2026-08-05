import Redis from 'ioredis';
import config from '../config/config.js';
import logger from '../utils/logger.js';

let client: Redis | null = null;

export function getRedisClient(): Redis {
  if (client) return client;

  client = new Redis(config.redis.url, {
    keyPrefix: config.redis.keyPrefix,
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 200, 2000);
    },
    lazyConnect: true,
  });

  client.on('error', (err) => {
    logger.error('Redis error:', err);
  });

  client.on('connect', () => {
    logger.info('Redis connected');
  });

  return client;
}

export async function initRedis(): Promise<Redis> {
  const c = getRedisClient();
  await c.connect();
  await c.ping();
  logger.info(`Redis connected to ${config.redis.url}`);
  return c;
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  await client.quit();
  client = null;
  logger.info('Redis connection closed');
}

export function isRedisEnabled(): boolean {
  return config.redis.enabled;
}
