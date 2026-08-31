/**
 * migrate-anchors-to-lock.ts — WS7.4 B4: move legacy anchor spellings to is_locked.
 *
 * THE DRIVER MOVED. All of the logic now lives in `src/cli/migrate-anchors.ts`
 * so it also ships in the published tarball (`scripts/ops` is not in
 * package.json's `files`, and `tsx` is a devDependency — a packaged install
 * could never run this file, yet doctor prescribes the migration to every
 * install that trips `legacy_anchor_count > 0`). The packaged entry point is
 * `kopeng migrate-anchors`.
 *
 * This file survives as the from-source `npm run migrate:anchors` wrapper and
 * as the import path `tests/unit/migrate-anchors-selection.test.ts` already
 * uses for `isLegacyAnchor` — it re-exports, it does not re-implement. Two
 * copies of a live-corpus write driver is exactly the drift this repo keeps
 * paying for elsewhere.
 *
 * Usage:
 *   npx tsx scripts/ops/migrate-anchors-to-lock.ts             # dry-run
 *   npx tsx scripts/ops/migrate-anchors-to-lock.ts --apply      # writes
 *
 * Env: MEMORY_API_URL (default http://localhost:3200), MEMORY_API_KEY / KOPENG_API_KEY / ADMIN_API_KEY.
 * Respects the server's 100-req/min rate limit (retries on 429 with Retry-After).
 *
 * The LIVE run against the operator's production corpus is an operator step
 * taken after merge — this driver is never pointed at a live server here.
 */

import { pathToFileURL } from 'url';

export {
  isLegacyAnchor,
  runMigrateAnchors,
  migrateAnchorsCli,
  MIGRATE_ANCHORS_USAGE,
  type LiteMemory,
  type MigrateAnchorsOptions,
  type MigrateAnchorsResult,
} from '../../src/cli/migrate-anchors.js';

import { migrateAnchorsCli } from '../../src/cli/migrate-anchors.js';

// Guarded so tests/unit/migrate-anchors-selection.test.ts can import this
// module (for isLegacyAnchor) without the CLI driver firing on import — an
// unguarded run would exit(1) on an unreachable server and kill the vitest
// process. tsx sets process.argv[1] to the script path when run from the CLI,
// so the guard still holds there.
const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  migrateAnchorsCli(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(err => {
      console.error(`migrate-anchors-to-lock failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
