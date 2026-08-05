import type { Session } from 'neo4j-driver';
import logger from '../utils/logger.js';

export interface GraphEntity {
  name: string;
  type: string; // 'person', 'project', 'technology', 'organization', 'concept'
}

export interface GraphRelation {
  from: string;
  to: string;
  type: string; // 'MENTIONS', 'RELATES_TO', 'DEPENDS_ON', 'AUTHORED_BY', 'PART_OF'
  memoryId: number;
}

export interface TraversalResult {
  entity: string;
  entityType: string;
  connectedMemoryIds: number[];
  relatedEntities: { name: string; type: string; relation: string }[];
}

// Allowed relationship types to prevent Cypher injection via string interpolation
const ALLOWED_RELATION_TYPES = new Set([
  'MENTIONS',
  'RELATES_TO',
  'DEPENDS_ON',
  'AUTHORED_BY',
  'PART_OF',
]);

function validateRelationType(relType: string): string {
  const normalized = relType.toUpperCase();
  if (!ALLOWED_RELATION_TYPES.has(normalized)) {
    logger.warn(`Unknown relation type "${relType}", defaulting to RELATES_TO`);
    return 'RELATES_TO';
  }
  return normalized;
}

export async function upsertMemoryNode(
  session: Session,
  memoryId: number,
  type: string,
  scope: string,
  summary: string
): Promise<void> {
  await session.run(
    `MERGE (m:Memory {memory_id: $memoryId})
     SET m.type = $type, m.scope = $scope, m.summary = $summary, m.updated_at = datetime()`,
    { memoryId, type, scope, summary }
  );
}

export async function upsertEntity(
  session: Session,
  entity: GraphEntity
): Promise<void> {
  await session.run(
    `MERGE (e:Entity {name: $name})
     SET e.type = $type, e.updated_at = datetime()`,
    { name: entity.name.toLowerCase(), type: entity.type }
  );
}

export async function createRelation(
  session: Session,
  relation: GraphRelation
): Promise<void> {
  const relType = validateRelationType(relation.type);

  // Create entity -> memory relation
  // Using APOC-free approach: since we validate relType against allowlist, interpolation is safe
  await session.run(
    `MATCH (from:Entity {name: $from})
     MATCH (m:Memory {memory_id: $memoryId})
     MERGE (from)-[:${relType}]->(m)`,
    { from: relation.from.toLowerCase(), memoryId: relation.memoryId }
  );

  if (relation.to) {
    await session.run(
      `MATCH (from:Entity {name: $from})
       MATCH (to:Entity {name: $to})
       MERGE (from)-[r:RELATES_TO]->(to)
       SET r.via_memory = $memoryId, r.updated_at = datetime()`,
      {
        from: relation.from.toLowerCase(),
        to: relation.to.toLowerCase(),
        memoryId: relation.memoryId,
      }
    );
  }
}

export async function traverseEntity(
  session: Session,
  entityName: string,
  _maxDepth: number = 2,
  _limit: number = 20
): Promise<TraversalResult> {
  const result = await session.run(
    `MATCH (e:Entity {name: $name})
     OPTIONAL MATCH (e)-[]->(m:Memory)
     WITH e, collect(DISTINCT m.memory_id) AS memoryIds
     OPTIONAL MATCH (e)-[r2:RELATES_TO]-(other:Entity)
     RETURN e.name AS entity, e.type AS entityType,
            memoryIds,
            collect(DISTINCT {name: other.name, type: other.type, relation: type(r2)}) AS relatedEntities`,
    { name: entityName.toLowerCase() }
  );

  if (result.records.length === 0) {
    return {
      entity: entityName,
      entityType: 'unknown',
      connectedMemoryIds: [],
      relatedEntities: [],
    };
  }

  const record = result.records[0];
  const entityVal = record.get('entity');

  // If entity node wasn't found, OPTIONAL MATCH returns nulls
  if (!entityVal) {
    return {
      entity: entityName,
      entityType: 'unknown',
      connectedMemoryIds: [],
      relatedEntities: [],
    };
  }

  return {
    entity: entityVal,
    entityType: record.get('entityType') || 'unknown',
    connectedMemoryIds: (record.get('memoryIds') || [])
      .filter((id: unknown) => id !== null)
      .map((id: unknown) => {
        if (typeof id === 'object' && id !== null && 'toNumber' in id) {
          return (id as { toNumber: () => number }).toNumber();
        }
        return Number(id);
      }),
    relatedEntities: (record.get('relatedEntities') || [])
      .filter((e: Record<string, unknown>) => e.name)
      .map((e: Record<string, unknown>) => ({
        name: e.name as string,
        type: (e.type as string) || 'unknown',
        relation: (e.relation as string) || 'RELATES_TO',
      })),
  };
}

export async function removeMemoryNode(
  session: Session,
  memoryId: number
): Promise<void> {
  await session.run(
    `MATCH (m:Memory {memory_id: $memoryId})
     DETACH DELETE m`,
    { memoryId }
  );
}

export interface BipartiteEntity {
  name: string;
  type: string;
  memoryCount: number;
}

export interface BipartiteLink {
  memoryId: number;
  entityName: string;
}

export interface BipartiteGraph {
  entities: BipartiteEntity[];
  links: BipartiteLink[];
}

export interface BipartiteOptions {
  min: number; // inclusive lower bound on entity reach (memories per entity)
  max: number; // inclusive upper bound — caps mega-hubs
  scope?: string;
  type?: string;
  entityTypes?: string[]; // optional allowlist of entity.type values
}

// Returns the bipartite memory↔entity graph as denormalised entities + edges.
// `min` filters orphan entities (default 2 skips entities seen in only one memory);
// `max` filters mega-hubs that would dominate the layout. Both bounds are applied
// against the entity's reach within the optionally-filtered memory set, so the
// frontend renders a self-consistent slice.
export async function getBipartiteGraph(
  session: Session,
  options: BipartiteOptions
): Promise<BipartiteGraph> {
  const params: Record<string, unknown> = {
    min: options.min,
    max: options.max,
    scope: options.scope ?? null,
    memType: options.type ?? null,
    entityTypes: options.entityTypes && options.entityTypes.length > 0
      ? options.entityTypes
      : null,
  };

  const result = await session.run(
    `MATCH (e:Entity)-[:MENTIONS|RELATES_TO|DEPENDS_ON|AUTHORED_BY|PART_OF]->(m:Memory)
     WHERE ($scope IS NULL OR m.scope = $scope)
       AND ($memType IS NULL OR m.type = $memType)
       AND ($entityTypes IS NULL OR e.type IN $entityTypes)
     WITH e, collect(DISTINCT m.memory_id) AS memIds
     WHERE size(memIds) >= $min AND size(memIds) <= $max
     RETURN e.name AS name, e.type AS type, size(memIds) AS memoryCount, memIds`,
    params
  );

  const toNum = (val: unknown): number => {
    if (typeof val === 'number') return val;
    if (typeof val === 'object' && val !== null && 'toNumber' in val) {
      return (val as { toNumber: () => number }).toNumber();
    }
    return Number(val);
  };

  const entities: BipartiteEntity[] = [];
  const links: BipartiteLink[] = [];

  for (const record of result.records) {
    const name = record.get('name') as string;
    const type = (record.get('type') as string) || 'unknown';
    const memoryCount = toNum(record.get('memoryCount'));
    const memIds = (record.get('memIds') as unknown[]) || [];

    entities.push({ name, type, memoryCount });
    for (const id of memIds) {
      links.push({ memoryId: toNum(id), entityName: name });
    }
  }

  return { entities, links };
}

export async function getGraphStats(
  session: Session
): Promise<{ entities: number; memories: number; relations: number }> {
  const result = await session.run(
    `MATCH (e:Entity) WITH count(e) AS entities
     MATCH (m:Memory) WITH entities, count(m) AS memories
     MATCH ()-[r]->() RETURN entities, memories, count(r) AS relations`
  );

  if (result.records.length === 0) {
    return { entities: 0, memories: 0, relations: 0 };
  }

  const record = result.records[0];
  const toNum = (val: unknown): number => {
    if (typeof val === 'object' && val !== null && 'toNumber' in val) {
      return (val as { toNumber: () => number }).toNumber();
    }
    return Number(val);
  };

  return {
    entities: toNum(record.get('entities')),
    memories: toNum(record.get('memories')),
    relations: toNum(record.get('relations')),
  };
}
