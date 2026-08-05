import type { Session } from 'neo4j-driver';
import { extractEntities } from './entity-extractor.js';
import { upsertMemoryNode, upsertEntity, createRelation } from './graph-queries.js';
import logger from '../utils/logger.js';

export async function processMemoryForGraph(
  session: Session,
  memoryId: number,
  content: string,
  type: string,
  scope: string,
  summary: string,
  tags: string[]
): Promise<{ entitiesFound: number; relationsCreated: number }> {
  try {
    // Create/update the memory node
    await upsertMemoryNode(
      session,
      memoryId,
      type,
      scope,
      summary || content.slice(0, 200)
    );

    // Extract entities
    const entities = extractEntities(content, type, scope, tags);

    // Create entity nodes and relations to the memory
    for (const entity of entities) {
      await upsertEntity(session, entity);
      await createRelation(session, {
        from: entity.name,
        to: '',
        type: 'MENTIONS',
        memoryId,
      });
    }

    // Create relations between entities found in same memory
    let relationsCreated = entities.length; // entity->memory relations
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        await createRelation(session, {
          from: entities[i].name,
          to: entities[j].name,
          type: 'RELATES_TO',
          memoryId,
        });
        relationsCreated++;
      }
    }

    return { entitiesFound: entities.length, relationsCreated };
  } catch (err) {
    logger.error(`Graph processing failed for memory ${memoryId}:`, err);
    return { entitiesFound: 0, relationsCreated: 0 };
  }
}
