import type { GraphEntity } from './graph-queries.js';

// Common technology names to recognize
const TECH_PATTERNS = new Set([
  'postgresql',
  'postgres',
  'redis',
  'neo4j',
  'minio',
  'sqlite',
  'docker',
  'kubernetes',
  'typescript',
  'javascript',
  'python',
  'node',
  'fastify',
  'react',
  'nextjs',
  'vercel',
  'aws',
  'azure',
  'gcp',
  'linux',
  'windows',
  'wireguard',
  'nginx',
  'systemd',
  'git',
  'github',
  'linear',
  'supabase',
  'cloudflare',
  'terraform',
  'ansible',
]);

export function extractEntities(
  content: string,
  _type: string,
  scope: string,
  tags: string[]
): GraphEntity[] {
  const entities: Map<string, GraphEntity> = new Map();

  // Extract from scope
  if (scope.startsWith('project:')) {
    const projectName = scope.replace('project:', '');
    entities.set(projectName, { name: projectName, type: 'project' });
  }
  if (scope.startsWith('client:')) {
    const clientName = scope.replace('client:', '');
    entities.set(clientName, { name: clientName, type: 'organization' });
  }

  // Extract technologies from content
  const words = content.toLowerCase().split(/[\s,;:()[\]{}"'`]+/);
  for (const word of words) {
    if (TECH_PATTERNS.has(word)) {
      entities.set(word, { name: word, type: 'technology' });
    }
  }

  // Extract from tags (tags are often entity-like)
  for (const tag of tags) {
    if (tag.length > 2 && !['ai', 'dev', 'ops', 'api'].includes(tag)) {
      const existingType = TECH_PATTERNS.has(tag) ? 'technology' : 'concept';
      if (!entities.has(tag)) {
        entities.set(tag, { name: tag, type: existingType });
      }
    }
  }

  return Array.from(entities.values());
}
