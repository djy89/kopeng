/**
 * Generate an eval dataset from existing memories using Claude API.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/seed-eval-dataset.ts [--count 30] [--dry-run]
 *
 * Fetches memories from the live REST API, uses Claude to generate
 * natural-language questions that each memory should answer,
 * and outputs data/eval_dataset.json.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const API_URL = process.env.MEMORY_API_URL || 'http://localhost:3200';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-sonnet-4-6';

interface Memory {
  id: number;
  content: string;
  type: string;
  scope: string;
  tags: string[];
}

interface EvalExample {
  id: string;
  query: string;
  relevant_memory_ids: number[];
  expected_answer_themes: string[];
}

// --- CLI args ---
function parseArgs(): { count: number; dryRun: boolean } {
  const args = process.argv.slice(2);
  let count = 30;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count' && args[i + 1]) {
      count = parseInt(args[++i], 10);
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  return { count, dryRun };
}

async function fetchMemories(limit: number): Promise<Memory[]> {
  const memories: Memory[] = [];
  let cursor: number | undefined;

  while (memories.length < limit) {
    const params = new URLSearchParams({
      limit: String(Math.min(50, limit - memories.length)),
    });
    if (cursor) params.set('cursor', String(cursor));

    const response = await fetch(`${API_URL}/api/memories?${params}`);
    if (!response.ok) throw new Error(`API returned ${response.status}`);

    const result = await response.json() as {
      data: Memory[];
      meta: { cursor?: number; has_more: boolean };
    };

    memories.push(...result.data);

    if (!result.meta.has_more || result.data.length === 0) break;
    cursor = result.meta.cursor;
  }

  return memories;
}

async function generateQuestion(memory: Memory): Promise<{ query: string; themes: string[] } | null> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }

  const prompt = `Given this memory stored in an AI agent's memory system, generate:
1. A natural-language search query that a user would type to find this memory. The query should be how someone would naturally ask for this information — not just keywords from the content.
2. 2-4 expected answer themes (short keywords or phrases that capture what the memory is about).

Memory content:
"""
${memory.content.slice(0, 1000)}
"""
Memory type: ${memory.type}
Memory scope: ${memory.scope}

Respond in JSON only, no markdown:
{"query": "...", "themes": ["...", "..."]}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`  Claude API error: ${response.status} ${err}`);
    return null;
  }

  const result = await response.json() as {
    content: Array<{ type: string; text: string }>;
  };

  const text = result.content[0]?.text;
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    return {
      query: parsed.query,
      themes: parsed.themes || [],
    };
  } catch {
    console.error(`  Failed to parse Claude response: ${text.slice(0, 100)}`);
    return null;
  }
}

async function main() {
  const { count, dryRun } = parseArgs();

  console.log(`\nSeed eval dataset: count=${count}, dry-run=${dryRun}`);

  if (!dryRun && !ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY to generate questions with Claude.');
    console.error('Usage: ANTHROPIC_API_KEY=sk-... npx tsx scripts/seed-eval-dataset.ts');
    process.exit(1);
  }

  // Fetch memories
  console.log(`Fetching up to ${count} memories from ${API_URL}...`);
  const memories = await fetchMemories(count);
  console.log(`Got ${memories.length} memories\n`);

  if (memories.length === 0) {
    console.error('No memories found. Store some memories first.');
    process.exit(1);
  }

  // Filter to memories with enough content for meaningful eval
  const viable = memories.filter(m => m.content.length >= 50);
  const selected = viable.slice(0, count);
  console.log(`Selected ${selected.length} memories with sufficient content\n`);

  if (dryRun) {
    console.log('Dry run — would generate questions for these memories:');
    for (const m of selected) {
      console.log(`  [ID:${m.id}] [${m.type}/${m.scope}] ${m.content.slice(0, 80)}...`);
    }
    return;
  }

  // Generate questions
  const dataset: EvalExample[] = [];

  for (let i = 0; i < selected.length; i++) {
    const memory = selected[i];
    process.stdout.write(`  [${i + 1}/${selected.length}] ID:${memory.id} ... `);

    const result = await generateQuestion(memory);
    if (!result) {
      console.log('SKIP');
      continue;
    }

    dataset.push({
      id: `eval_${String(i + 1).padStart(3, '0')}`,
      query: result.query,
      relevant_memory_ids: [memory.id],
      expected_answer_themes: result.themes,
    });

    console.log('OK');

    // Rate limiting — be respectful to the API
    if (i < selected.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Save
  const outputPath = path.join(projectRoot, 'data', 'eval_dataset.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(dataset, null, 2));

  console.log(`\nGenerated ${dataset.length} eval examples`);
  console.log(`Saved to: ${outputPath}`);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
