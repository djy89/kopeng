import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  const apiUrl = process.env.MEMORY_API_URL || 'http://localhost:3200';
  const maintain = process.argv.includes('--maintain');

  if (maintain) {
    console.log(`Running discovery maintenance against ${apiUrl}...`);

    const response = await fetch(`${apiUrl}/api/admin/discovery/maintain`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Admin-gated since Round 7 (B3) — this script never sent the key, so it
        // 401'd on any server with ADMIN_API_KEY configured.
        ...(process.env.ADMIN_API_KEY ? { 'x-api-key': process.env.ADMIN_API_KEY } : {}),
      },
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`Maintenance failed (${response.status}): ${text}`);
      process.exit(1);
    }

    const result = await response.json() as {
      data: {
        observations_purged: number;
        memories_archived: number;
        memories_promoted: number;
        duration_ms: number;
      };
    };

    const d = result.data;
    console.log(`Maintenance completed in ${d.duration_ms}ms:`);
    console.log(`  Observations purged: ${d.observations_purged}`);
    console.log(`  Memories archived:   ${d.memories_archived}`);
    console.log(`  Memories promoted:   ${d.memories_promoted}`);
  } else {
    console.log(`Triggering discovery against ${apiUrl}...`);

    const response = await fetch(`${apiUrl}/api/discover`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Admin-gated since Round 7 (B3) — this script never sent the key, so it
        // 401'd on any server with ADMIN_API_KEY configured.
        ...(process.env.ADMIN_API_KEY ? { 'x-api-key': process.env.ADMIN_API_KEY } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`Discovery failed (${response.status}): ${text}`);
      process.exit(1);
    }

    const result = await response.json() as {
      data: {
        run_id: number;
        project_scope: string;
        observations_analyzed: number;
        patterns_found: number;
        memories_created: number;
        memories_reinforced: number;
        duration_ms: number;
      };
    };

    const d = result.data;
    if (d.observations_analyzed === 0) {
      console.log('No unprocessed observations to analyze.');
    } else {
      console.log(`Discovery completed in ${d.duration_ms}ms:`);
      console.log(`  Observations analyzed: ${d.observations_analyzed}`);
      console.log(`  Patterns found:        ${d.patterns_found}`);
      console.log(`  Memories created:      ${d.memories_created}`);
      console.log(`  Memories reinforced:   ${d.memories_reinforced}`);
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error.message || error);
  process.exit(1);
});
