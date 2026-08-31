/**
 * One definition of "was this module run directly, rather than imported?".
 *
 * The obvious spelling is wrong, and was wrong at 12 shipped call sites until
 * the first-ever macOS install smoke caught it (T72):
 *
 *     path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
 *
 * Node's ESM loader resolves symlinks for the main entry, so `import.meta.url`
 * is always a REALPATH. `process.argv[1]` is the path as typed. Whenever the
 * entry is reached through a symlink the two disagree, the guard reads false,
 * `main()` silently never runs, and the process exits 0 having done nothing —
 * no output, no error, nothing to debug.
 *
 * That is not a CI artifact. It fires on:
 *   - macOS, where `os.tmpdir()` is `/var/folders/...` and `/var` -> `/private/var`
 *     (and `/tmp` -> `/private/tmp`) — the exact shape that made `kopeng init`
 *     exit 0 without writing `.env`;
 *   - pnpm, whose `node_modules` layout is symlinks by design, on every platform;
 *   - `npm link`, Homebrew prefixes, and home directories on network mounts.
 *
 * Fix: realpath the argv side before comparing, and fall back to the plain
 * resolve when the realpath call fails (a deleted or unreadable entry must
 * degrade to the old behaviour, never throw out of a module's top level).
 */
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Case-fold only where the filesystem does. Linux paths are case-sensitive. */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * True when `importMetaUrl`'s module is the process entry point.
 *
 * @param importMetaUrl always pass `import.meta.url` from the calling module.
 */
export function isEntrypoint(importMetaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;

  let target: string;
  try {
    target = fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }

  const resolved = path.resolve(argv1);
  if (samePath(resolved, target)) return true;

  // The symlinked case: argv[1] is the path as typed, target is the realpath.
  try {
    if (samePath(realpathSync(resolved), target)) return true;
  } catch { /* entry no longer readable — fall through */ }

  // The inverse, for hosts that hand us an already-resolved argv[1] while the
  // module URL still carries a link (e.g. --preserve-symlinks-main).
  try {
    if (samePath(resolved, realpathSync(target))) return true;
  } catch { /* target no longer readable — fall through */ }

  return false;
}
