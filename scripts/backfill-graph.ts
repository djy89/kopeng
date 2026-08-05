import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Session } from 'neo4j-driver';
import config from '../src/config/config.js';
import type { IMemoryStore } from '../src/database/interfaces.js';
import { getDatabase, closeDatabase } from '../src/database/database.js';
import { MemoryQueries } from '../src/database/queries.js';
import { initPostgres, closePool } from '../src/database/postgres.js';
import { PgQueries } from '../src/database/pg-queries.js';
import { initNeo4j, closeNeo4j, getSession } from '../src/graph/neo4j.js';
import { processMemoryForGraph } from '../src/graph/extraction-pipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function getBackfillDelayMs(): number {
  const value = Number(process.env.BACKFILL_DELAY_MS ?? '650');
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('BACKFILL_DELAY_MS must be a non-negative number');
  }
  return value;
}

async function createMemoryStore(): Promise<{
  memoryStore: IMemoryStore;
  close: () => Promise<void>;
}> {
  if (config.database.type === 'postgres') {
    const pool = await initPostgres();
    return {
      memoryStore: new PgQueries(pool),
      close: closePool,
    };
  }

  const db = getDatabase();
  return {
    memoryStore: new MemoryQueries(db),
    close: async () => {
      closeDatabase();
    },
  };
}

async function processMemories(
  memoryStore: IMemoryStore,
  session: Session,
  perMemoryDelayMs: number
): Promise<{ total: number; processed: number }> {
  let cursor: number | undefined;
  let total = 0;
  let processed = 0;

  do {
    const result = await memoryStore.list({
      cursor,
      limit: 50,
      include_archived: false,
    });

    for (const memory of result.memories) {
      const graphResult = await processMemoryForGraph(
        session,
        memory.id,
        memory.content,
        memory.type,
        memory.scope,
        memory.summary || '',
        memory.tags
      );

      if (graphResult.entitiesFound > 0 || graphResult.relationsCreated > 0) {
        processed++;
      }

      await sleep(perMemoryDelayMs);
    }

    total += result.memories.length;
    const lastMemory = result.memories[result.memories.length - 1];
    cursor = result.has_more && lastMemory ? lastMemory.id : undefined;
    console.log(`Scanned ${total} memories so far...`);
  } while (cursor);

  return { total, processed };
}

async function main(): Promise<void> {
  if (!config.neo4j.enabled) {
    throw new Error('NEO4J_ENABLED must be true before running graph backfill');
  }

  const perMemoryDelayMs = getBackfillDelayMs();
  console.log(`Starting graph backfill with ${perMemoryDelayMs}ms delay per memory...`);

  const { memoryStore, close: closeMemoryStore } = await createMemoryStore();
  await initNeo4j();
  const session = getSession();

  try {
    const { total, processed } = await processMemories(
      memoryStore,
      session,
      perMemoryDelayMs
    );
    console.log(`Graph backfill complete: ${processed}/${total} memories produced graph entities`);
  } finally {
    await session.close();
    await closeNeo4j();
    await closeMemoryStore();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
