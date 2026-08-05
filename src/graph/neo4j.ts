import neo4j from 'neo4j-driver';
import type { Driver, Session } from 'neo4j-driver';
import config from '../config/config.js';
import logger from '../utils/logger.js';

let driver: Driver | null = null;

export function getNeo4jDriver(): Driver {
  if (driver) return driver;
  driver = neo4j.driver(
    config.neo4j.url,
    neo4j.auth.basic(config.neo4j.username, config.neo4j.password)
  );
  return driver;
}

export async function initNeo4j(): Promise<Driver> {
  const d = getNeo4jDriver();
  // Verify connectivity
  const session = d.session();
  try {
    await session.run('RETURN 1');
    logger.info('Neo4j connection established');
  } finally {
    await session.close();
  }
  // Run schema setup
  await setupSchema(d);
  return d;
}

async function setupSchema(d: Driver): Promise<void> {
  const session = d.session();
  try {
    await session.run(
      'CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:Memory) REQUIRE m.memory_id IS UNIQUE'
    );
    await session.run(
      'CREATE CONSTRAINT entity_name IF NOT EXISTS FOR (e:Entity) REQUIRE e.name IS UNIQUE'
    );
    await session.run(
      'CREATE INDEX entity_type IF NOT EXISTS FOR (e:Entity) ON (e.type)'
    );
    logger.info('Neo4j schema initialized');
  } finally {
    await session.close();
  }
}

export async function closeNeo4j(): Promise<void> {
  if (!driver) return;
  await driver.close();
  driver = null;
  logger.info('Neo4j driver closed');
}

export function getSession(): Session {
  return getNeo4jDriver().session();
}
