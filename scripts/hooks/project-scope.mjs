/**
 * KOPENG project-scope derivation (RULING-C, WS7.6).
 *
 * `project:<basename(cwd)>` is a weak identity: two repos named `api` under
 * different owners collide, and two worktrees of one repo split apart. The
 * operator ruled a better default — `project:<owner>-<repo>` parsed from the
 * git remote — with `.kopeng.json`'s `project` key able to override it, and
 * `basename(cwd)` as the byte-identical fallback when no remote is usable.
 *
 * Pure fs — NO child_process. The observe hook runs on every tool call, and
 * git-the-binary may be entirely absent (T57: gitless installs are real), so
 * this reads .git/config directly instead of shelling out to `git`.
 *
 * Precedence, each step fail-open (any fs/parse surprise falls through to the
 * next step, never throws into a caller hook):
 *   1. `.kopeng.json` `project` field (scope-shaped: `project:`/`client:` prefix)
 *   2. the nearest `.git`'s remote → `project:<owner>-<repo>`
 *   3. `project:<basename(cwd)>`
 */

import { readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';

const MAX_WALK_DEPTH = 12; // same bound as the anchor-marker walk
const MARKER_FILE = '.kopeng.json';
const MAX_SCOPE_LEN = 128; // matches the server's sanitizer bound

function isScopeShaped(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SCOPE_LEN
    && /^(?:project|client):.+$/.test(value);
}

/**
 * The ONE ancestor walk over `.kopeng.json`, shared by both of the file's readers:
 * this module's `project` override (below) and the recall hook's `scopes` list
 * (readAnchorScopes in memory-prompt-search.mjs). They read DIFFERENT keys and have
 * DIFFERENT stop rules — first hit here, keep-collecting there — so the walk runs to
 * FULL depth and hands back every marker it parsed, nearest first; each consumer
 * applies its own stop rule to the result.
 *
 * Before it was shared, the recall hook made this identical 12-level walk TWICE per
 * prompt: ~12 redundant readFileSync calls, almost all ENOENT. Free on local NTFS, up
 * to ~120ms on a network share or a WSL /mnt/c cwd — and both walks run BEFORE the 3s
 * recall AbortSignal is armed, so it was wall-clock stacked on top of that ceiling
 * rather than absorbed inside it.
 *
 * Fail-open per level: a missing, unreadable, or malformed marker is skipped and the
 * walk CONTINUES, so one broken child marker can never hide a valid ancestor's.
 */
export function readMarkerChain(startDir, { maxDepth = MAX_WALK_DEPTH } = {}) {
  const markers = [];
  // Never throws into a caller hook: the recall hook calls this OUTSIDE the
  // safe() wrapper deriveProjectScope uses, so the one unguarded step is guarded here.
  let dir;
  try { dir = resolve(String(startDir)); } catch { return markers; }
  for (let depth = 0; depth < maxDepth; depth++) {
    try {
      markers.push(JSON.parse(readFileSync(join(dir, MARKER_FILE), 'utf-8')));
    } catch { /* missing/malformed marker — keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return markers;
}

/**
 * Step 1: the NEAREST marker whose `project` field is scope-shaped. Stops at the
 * first hit; a wrong-shaped field is skipped, never hiding a valid ancestor marker.
 */
function findMarkerScope(markers) {
  for (const parsed of markers) {
    if (parsed && isScopeShaped(parsed.project)) return parsed.project;
  }
  return null;
}

/** Step 2a: walk up for the nearest `.git` — a directory, or a worktree/submodule
 * FILE carrying a `gitdir:` pointer. Stops at the first one found; does not keep
 * searching past it for another. */
function findGitEntry(cwd) {
  let dir = resolve(String(cwd));
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    const gitPath = join(dir, '.git');
    try {
      const st = statSync(gitPath);
      if (st.isDirectory()) return { kind: 'dir', configs: [join(gitPath, 'config')] };
      if (st.isFile()) return { kind: 'file', dir, gitPath };
    } catch { /* no .git here — keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** A `.git` FILE's candidate configs: its own gitdir config, then — via
 * commondir, when present — the shared repo's config, which is where a
 * worktree's remotes actually live (a worktree's own gitdir rarely has one). */
function worktreeConfigs(entry) {
  const content = readFileSync(entry.gitPath, 'utf-8');
  const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) return [];
  const gitdir = resolve(entry.dir, match[1]); // resolve() no-ops when match[1] is already absolute
  const configs = [join(gitdir, 'config')];
  try {
    const commondir = readFileSync(join(gitdir, 'commondir'), 'utf-8').trim();
    if (commondir) configs.push(join(resolve(gitdir, commondir), 'config'));
  } catch { /* no commondir — the gitdir's own config is the only candidate */ }
  return configs;
}

/** Line-based INI scan: prefer `[remote "origin"]`, else the first `[remote "…"]`. */
function findRemoteUrl(configText) {
  let section = null; // remote name while inside a `[remote "…"]` section, else null
  let originUrl = null;
  let firstRemoteUrl = null;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    const header = line.match(/^\[([A-Za-z0-9_.-]+)(?:\s+"([^"]*)")?\]$/);
    if (header) {
      section = header[1].toLowerCase() === 'remote' ? (header[2] ?? '') : null;
      continue;
    }
    if (section === null) continue;
    const kv = line.match(/^url\s*=\s*(.+)$/i);
    if (!kv) continue;
    const url = kv[1].trim();
    if (firstRemoteUrl === null) firstRemoteUrl = url;
    if (section === 'origin' && originUrl === null) originUrl = url;
  }
  return originUrl ?? firstRemoteUrl ?? null;
}

const sanitizeSegment = (s) => s.replace(/[^A-Za-z0-9._-]/g, '-');

/**
 * scp-like ssh (`git@host:owner/repo.git`), `ssh://[user@]host[:port]/…`, and
 * `http(s)://host/…` all normalize to the LAST TWO path segments (covers deep
 * GitLab-group paths too). `file://` and bare local paths carry no hosted
 * identity and return null.
 */
function ownerRepoFromUrl(url) {
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url);
  let pathPart;
  if (hasScheme) {
    if (/^file:\/\//i.test(url)) return null;
    const m = url.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/@]+@)?[^/]+(\/.*)$/);
    if (!m) return null;
    pathPart = m[1];
  } else {
    const scp = url.match(/^[^/\s@]+@[^/\s:]+:(.+)$/); // git@host:owner/repo.git
    if (!scp) return null; // bare local path — not a hosted identity
    pathPart = scp[1];
  }
  const segments = pathPart.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const repo = sanitizeSegment(segments[segments.length - 1].replace(/\.git$/i, ''));
  const owner = sanitizeSegment(segments[segments.length - 2]);
  return owner && repo ? { owner, repo } : null;
}

/** Step 2: git remote → `project:<owner>-<repo>`, spelling preserved. */
function deriveFromRemote(cwd) {
  const entry = findGitEntry(cwd);
  if (!entry) return null;
  let configs;
  try {
    configs = entry.kind === 'dir' ? entry.configs : worktreeConfigs(entry);
  } catch {
    return null;
  }
  let url = null;
  for (const configPath of configs) {
    let text;
    try { text = readFileSync(configPath, 'utf-8'); } catch { continue; }
    url = findRemoteUrl(text);
    if (url) break;
  }
  if (!url) return null;
  const ownerRepo = ownerRepoFromUrl(url);
  if (!ownerRepo) return null;
  return { scope: `project:${ownerRepo.owner}-${ownerRepo.repo}`.slice(0, MAX_SCOPE_LEN), source: 'remote' };
}

function safe(fn) {
  try { return fn(); } catch { return null; }
}

/**
 * Derive the project scope for `cwd`. Fail-open at every step: a marker or
 * git surprise falls through to the next step rather than throwing.
 *
 * `markers` is an optional pre-read chain from `readMarkerChain(cwd)` — pass it when
 * the caller also reads the `scopes` key off the same walk (the recall hook does) so
 * the ancestor chain is read once per prompt instead of twice. Omitted ⇒ this walks
 * itself, so every other caller is unchanged.
 */
export function deriveProjectScope(cwd, { markers } = {}) {
  const marker = safe(() => findMarkerScope(markers ?? readMarkerChain(cwd)));
  if (marker) return { scope: marker, source: 'marker' };
  const remote = safe(() => deriveFromRemote(cwd));
  if (remote) return remote;
  return { scope: `project:${basename(String(cwd))}`, source: 'basename' };
}
