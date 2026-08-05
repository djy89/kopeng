/**
 * Idempotent migration: file-based .claude/projects/*/memory/*.md → KOPENG REST API
 *
 * Usage: npx tsx scripts/migrate-from-files.ts [--dry-run]
 * Requires the REST server to be running on MEMORY_API_URL (default localhost:3200)
 */

import fs from 'fs';
import path from 'path';

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
// Load this repo's .env so ADMIN_API_KEY is present when run from a scheduled
// task or a bare shell, where it is not otherwise in the environment. Non-
// overriding: a value already exported wins. Without this the script silently
// 401s against a key-configured server (sweep-3 PB-2 made memory writes gated).
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const API_URL = process.env.MEMORY_API_URL || 'http://localhost:3200';
const CLAUDE_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'projects');
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 50;

interface ParsedMemory {
  content: string;
  name: string;
  description: string;
  type: string;
  scope: string;
  source_path: string;
  tags: string[];
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw.trim() };

  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fm[key] = value;
  }

  return { frontmatter: fm, body: match[2].trim() };
}

function deriveScope(dirPath: string): string {
  // Extract project name from path like C--Users-dev--Desktop-Apps--projectName
  const dirName = path.basename(path.dirname(dirPath)); // parent of 'memory' dir
  // Try to extract meaningful project name
  const parts = dirName.split('--');
  const projectName = parts[parts.length - 1] || 'unknown';

  if (projectName === 'unknown' || dirName === 'projects') return 'global';
  return `project:${projectName}`;
}

function parseMemoryFile(filePath: string): ParsedMemory | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);

    if (!body || body.length < 5) return null;

    const validTypes = ['user', 'feedback', 'project', 'reference'];
    const type = validTypes.includes(frontmatter.type) ? frontmatter.type : 'reference';

    const scope = deriveScope(filePath);

    return {
      content: body,
      name: frontmatter.name || path.basename(filePath, '.md'),
      description: frontmatter.description || '',
      type,
      scope,
      source_path: filePath,
      tags: [],
    };
  } catch (err) {
    console.error(`Failed to parse ${filePath}:`, err);
    return null;
  }
}

function parseMemoryIndex(indexPath: string, scope: string): ParsedMemory[] {
  try {
    const raw = fs.readFileSync(indexPath, 'utf-8');
    const sections = raw.split(/^## /gm).filter(s => s.trim());
    const memories: ParsedMemory[] = [];

    for (const section of sections) {
      const lines = section.split('\n');
      const heading = lines[0]?.trim();
      if (!heading) continue;

      const body = lines.slice(1).join('\n').trim();
      if (!body || body.length < 10) continue;

      memories.push({
        content: body,
        name: heading,
        description: `Index entry: ${heading}`,
        type: 'reference',
        scope,
        source_path: indexPath,
        tags: ['index-entry'],
      });
    }

    return memories;
  } catch {
    return [];
  }
}

async function findMemoryFiles(): Promise<string[]> {
  const files: string[] = [];

  if (!fs.existsSync(CLAUDE_DIR)) {
    console.log(`No .claude/projects directory found at ${CLAUDE_DIR}`);
    return files;
  }

  const projects = fs.readdirSync(CLAUDE_DIR);
  for (const project of projects) {
    const memoryDir = path.join(CLAUDE_DIR, project, 'memory');
    if (!fs.existsSync(memoryDir)) continue;

    const memFiles = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md'));
    for (const memFile of memFiles) {
      files.push(path.join(memoryDir, memFile));
    }
  }

  return files;
}

async function migrate() {
  console.log(`Migration: file-based memories → KOPENG`);
  console.log(`API URL: ${API_URL}`);
  console.log(`Source: ${CLAUDE_DIR}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log('');

  // Check API health
  try {
    const health = await fetch(`${API_URL}/api/health`);
    if (!health.ok) throw new Error(`Health check failed: ${health.status}`);
    const healthData = await health.json();
    console.log(`Server status: ${healthData.data.status}`);
  } catch (err: any) {
    console.error(`Cannot reach KOPENG server at ${API_URL}: ${err.message}`);
    console.error('Start the server first: npm run start');
    process.exit(1);
  }

  // Find all memory files
  const files = await findMemoryFiles();
  console.log(`Found ${files.length} memory files`);

  // Parse all memories
  const allMemories: ParsedMemory[] = [];

  for (const file of files) {
    const basename = path.basename(file);

    if (basename === 'MEMORY.md') {
      // Parse index file into individual entries
      const scope = deriveScope(file);
      const entries = parseMemoryIndex(file, scope);
      allMemories.push(...entries);
      console.log(`  ${file} → ${entries.length} index entries`);
    } else {
      const memory = parseMemoryFile(file);
      if (memory) {
        allMemories.push(memory);
        console.log(`  ${file} → parsed`);
      } else {
        console.log(`  ${file} → skipped (empty or invalid)`);
      }
    }
  }

  console.log(`\nTotal memories to migrate: ${allMemories.length}`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No memories were stored.');
    for (const m of allMemories) {
      console.log(`  - [${m.type}/${m.scope}] ${m.name}: ${m.content.slice(0, 80)}...`);
    }
    return;
  }

  // Batch upload
  let stored = 0;
  let duplicates = 0;

  for (let i = 0; i < allMemories.length; i += BATCH_SIZE) {
    const batch = allMemories.slice(i, i + BATCH_SIZE);

    const payload = {
      memories: batch.map(m => ({
        content: m.content,
        type: m.type,
        scope: m.scope,
        source: 'migration',
        source_path: m.source_path,
        metadata: { name: m.name, description: m.description },
        tags: m.tags,
        created_by: 'migration-script',
      })),
    };

    const response = await fetch(`${API_URL}/api/memories/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Memory writes are admin-key gated when the server has ADMIN_API_KEY set.
        ...(process.env.ADMIN_API_KEY ? { 'x-api-key': process.env.ADMIN_API_KEY } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`Batch ${i / BATCH_SIZE + 1} failed: ${err}`);
      continue;
    }

    const result = await response.json();
    stored += result.data.inserted;
    duplicates += result.data.duplicates;

    console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${result.data.inserted} stored, ${result.data.duplicates} duplicates`);
  }

  console.log(`\nMigration complete: ${stored} stored, ${duplicates} duplicates skipped`);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
