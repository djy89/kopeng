import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  const apiUrl = process.env.MEMORY_API_URL || 'http://localhost:3200';
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Running promotion pipeline against ${apiUrl}${dryRun ? ' (DRY RUN)' : ''}...`);

  const response = await fetch(`${apiUrl}/api/admin/promote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // T27: mutating operator endpoint — admin-key gated when the server has ADMIN_API_KEY set
      ...(process.env.ADMIN_API_KEY ? { 'x-api-key': process.env.ADMIN_API_KEY } : {}),
    },
    body: JSON.stringify({ dry_run: dryRun }),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    console.error(`Promotion failed: ${response.status} ${await response.text()}`);
    process.exit(1);
  }

  const result = await response.json();
  console.log('\nPromotion Results:');
  console.log(JSON.stringify(result.data, null, 2));
}

main().catch((err) => {
  console.error('Promotion script failed:', err);
  process.exit(1);
});
