/**
 * Hook-tree twin of `src/utils/entrypoint.ts` — see that file for the full
 * rationale (T72: `import.meta.url` is realpath'd, `process.argv[1]` is not,
 * so every guard spelled as a direct comparison reads FALSE when the entry is
 * reached through a symlink and `main()` silently never runs).
 *
 * This is a deliberate port, not drift. The hooks are standalone scripts that
 * must run with no build step and no dependency on `dist/`, exactly like
 * `getSequenceKey()` is ported from `src/discovery/heuristics.ts`. The two
 * implementations are pinned to agree by tests/unit/entrypoint-guard.test.ts.
 */
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function samePath(a, b) {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * True when `importMetaUrl`'s module is the process entry point.
 * @param {string} importMetaUrl always pass `import.meta.url` from the caller.
 * @returns {boolean}
 */
export function isEntrypoint(importMetaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;

  let target;
  try {
    target = fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }

  const resolved = path.resolve(argv1);
  if (samePath(resolved, target)) return true;

  try {
    if (samePath(realpathSync(resolved), target)) return true;
  } catch { /* entry no longer readable — fall through */ }

  try {
    if (samePath(resolved, realpathSync(target))) return true;
  } catch { /* target no longer readable — fall through */ }

  return false;
}
