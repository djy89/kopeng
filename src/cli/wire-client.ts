import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Both pure/side-effect-free (no config.ts eager validation) — safe to import
// statically, unlike ensure.ts/config.ts. See env-resolution.ts's own header.
import { resolveEnvFile } from '../config/env-resolution.js';
import { ENV_FILE as PACKAGED_ENV_FILE } from './paths.js';
import { isEntrypoint } from '../utils/entrypoint.js';

type JsonObject = Record<string, unknown>;
export type WireProfile = 'minimal' | 'recommended' | 'everything';

export interface WireOptions {
  homeDir?: string;
  repoRoot?: string;
  repoRootExplicit?: boolean;
  apiUrl?: string;
  profile?: WireProfile;
  apply?: boolean;
  now?: Date;
  log?: (line: string) => void;
  /**
   * Task 2.2 fix round 1 (finding 1): the target .env for the profile-flag
   * write. Explicit wins outright. Defaults to `resolveEnvFile` (Ruling 7/8)
   * over `env` — so a packaged install's repoRoot (inside node_modules)
   * resolves to `~/.kopeng/.env` instead of silently shadowing it with a
   * second .env under node_modules/kopeng. A from-source repoRoot is
   * unaffected (resolveEnvFile returns `<repoRoot>/.env` either way).
   */
  envFile?: string;
  /** Launch environment consulted for the envFile default (KOPENG_ENV_FILE). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface WireResult {
  changed: boolean;
  applied: boolean;
  changes: string[];
  backups: string[];
  claudeConfigPath: string;
  settingsPath: string;
}

interface JsonFile {
  path: string;
  exists: boolean;
  value: JsonObject;
}

interface WorktreeInfo {
  linked: boolean;
  canonicalRoot?: string;
}

interface EnvFlagPlan {
  name: ProfileFlag;
  current?: string;
  proposed?: string;
  preserved: boolean;
}

interface EnvPlan {
  path: string;
  exists: boolean;
  source: string;
  proposed: string;
  flags: EnvFlagPlan[];
  changes: string[];
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_API_URL = 'http://localhost:3200';
const PROFILE_FLAGS = [
  'OBSERVATION_INGESTION_ENABLED',
  'DISCOVERY_DETECTION_ENABLED',
  'DREAMING_ENABLED',
] as const;
type ProfileFlag = (typeof PROFILE_FLAGS)[number];

export const PROFILE_DESCRIPTIONS: Record<WireProfile, string> = {
  minimal: 'Adds no learning flags; fresh installs use manual memory only.',
  recommended: 'Adds passive-learning flags; does not add consolidation.',
  everything: 'Adds passive learning plus nightly consolidation; never arms auto-apply.',
};

const PROFILE_VALUES: Record<WireProfile, Partial<Record<ProfileFlag, 'true'>>> = {
  minimal: {},
  recommended: {
    OBSERVATION_INGESTION_ENABLED: 'true',
    DISCOVERY_DETECTION_ENABLED: 'true',
  },
  everything: {
    OBSERVATION_INGESTION_ENABLED: 'true',
    DISCOVERY_DETECTION_ENABLED: 'true',
    DREAMING_ENABLED: 'true',
  },
};

export const HOOK_DEFINITIONS = [
  {
    event: 'SessionStart',
    script: 'memory-session-start.mjs',
    matcher: 'startup|resume',
    timeout: 8,
  },
  {
    event: 'UserPromptSubmit',
    script: 'memory-prompt-search.mjs',
    timeout: 5,
  },
  {
    event: 'PreToolUse',
    script: 'kopeng-observe.js',
    suffix: 'tool_start',
    timeout: 3,
  },
  {
    event: 'PostToolUse',
    script: 'kopeng-observe.js',
    suffix: 'tool_complete',
    timeout: 3,
  },
  {
    event: 'SessionEnd',
    script: 'memory-session-end.mjs',
    timeout: 10,
  },
] as const;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function readJsonFile(filePath: string): JsonFile {
  if (!fs.existsSync(filePath)) return { path: filePath, exists: false, value: {} };

  const source = fs.readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.replace(/^\uFEFF/, ''));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${filePath} contains invalid JSON (${detail}). Fix it first; no files were changed.`);
  }
  if (!isObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object. Fix it first; no files were changed.`);
  }
  return { path: filePath, exists: true, value: parsed };
}

function objectField(parent: JsonObject, key: string, label: string): JsonObject {
  const value = parent[key];
  if (value === undefined) {
    const created: JsonObject = {};
    parent[key] = created;
    return created;
  }
  if (!isObject(value)) throw new Error(`${label} must be a JSON object; no files were changed.`);
  return value;
}

function posixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function cliValue(value: string): string {
  const normalized = posixPath(value);
  return /\s/.test(normalized) ? `"${normalized}"` : normalized;
}

function validateRepoRoot(repoRoot: string): void {
  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
    throw new Error(`Repo root does not exist or is not a directory: ${posixPath(repoRoot)}. No files were changed.`);
  }

  const packagePath = path.join(repoRoot, 'package.json');
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Repo root must contain a readable package.json (${detail}). No files were changed.`);
  }
  if (!isObject(packageJson) || packageJson.name !== 'kopeng') {
    throw new Error(`Repo root package.json must have \"name\": \"kopeng\": ${posixPath(repoRoot)}. No files were changed.`);
  }

  const hooksDir = path.join(repoRoot, 'scripts', 'hooks');
  if (!fs.existsSync(hooksDir) || !fs.statSync(hooksDir).isDirectory()) {
    throw new Error(`Repo root must contain scripts/hooks/: ${posixPath(repoRoot)}. No files were changed.`);
  }
}

function linkedWorktreeInfo(repoRoot: string): WorktreeInfo {
  const dotGit = path.join(repoRoot, '.git');
  let stat: fs.Stats;
  try { stat = fs.statSync(dotGit); } catch { return { linked: false }; }
  if (!stat.isFile()) return { linked: false };

  let pointer: string;
  try { pointer = fs.readFileSync(dotGit, 'utf8').trim(); } catch { return { linked: false }; }
  const match = /^gitdir:\s*(.+)$/i.exec(pointer);
  if (!match) return { linked: false };

  const gitDir = path.resolve(repoRoot, match[1]);
  try {
    const commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    if (path.basename(commonDir).toLowerCase() !== '.git') return { linked: true };
    const candidate = path.dirname(commonDir);
    validateRepoRoot(candidate);
    return { linked: true, canonicalRoot: candidate };
  } catch {
    return { linked: true };
  }
}

function worktreeMessage(repoRoot: string, canonicalRoot?: string): string[] {
  const target = canonicalRoot ? cliValue(canonicalRoot) : '<path-to-stable-kopeng-checkout>';
  return [
    `WARNING: ${posixPath(repoRoot)} is a linked Git worktree; paths from it may be temporary.`,
    'Run from the canonical checkout, or pass it explicitly:',
    `  npm run wire -- --apply --repo-root ${target}`,
  ];
}

function assignedEnvKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) keys.add(match[1]);
  }
  return keys;
}

function appendEnvValues(source: string, additions: Array<[ProfileFlag, string]>): string {
  if (additions.length === 0) return source;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let proposed = source;
  if (proposed.length > 0 && !proposed.endsWith('\n')) proposed += newline;
  if (!proposed.includes('# KOPENG activation profile')) {
    proposed += `# KOPENG activation profile — explicit values are never overwritten${newline}`;
  }
  proposed += additions.map(([name, value]) => `${name}=${value}`).join(newline) + newline;
  return proposed;
}

// Task 2.2 (init): split into a pure core taking the target env PATH directly
// (init writes ~/.kopeng/.env, not a repo-relative one) plus a thin wrapper
// that reads the file for wireClient's own repo-.env use — same shape as the
// autostart.ts/doctor.ts plan/apply idiom elsewhere in this file.
export function planProfileEnvFromSource(envPath: string, exists: boolean, source: string, profile: WireProfile): EnvPlan {
  const assigned = assignedEnvKeys(source);
  const parsed = dotenv.parse(source);
  const desired = PROFILE_VALUES[profile];
  const additions: Array<[ProfileFlag, string]> = [];
  const flags = PROFILE_FLAGS.map(name => {
    const current = assigned.has(name) ? (parsed[name] ?? '<set>') : undefined;
    const requested = desired[name];
    if (current === undefined && requested !== undefined) additions.push([name, requested]);
    return {
      name,
      current,
      proposed: current ?? requested,
      preserved: current !== undefined,
    };
  });
  return {
    path: envPath,
    exists,
    source,
    proposed: appendEnvValues(source, additions),
    flags,
    changes: additions.map(([name, value]) => `add .env ${name}=${value}`),
  };
}

export function planProfileEnv(envPath: string, profile: WireProfile): EnvPlan {
  const exists = fs.existsSync(envPath);
  const source = exists ? fs.readFileSync(envPath, 'utf8') : '';
  return planProfileEnvFromSource(envPath, exists, source, profile);
}

function logProfileReport(log: (line: string) => void, profile: WireProfile, plan: EnvPlan): void {
  log(`Activation profile: ${profile} — ${PROFILE_DESCRIPTIONS[profile]}`);
  for (const flag of plan.flags) {
    if (flag.preserved) {
      log(`  ${flag.name}: existing explicit value ${JSON.stringify(flag.current)} preserved.`);
    } else if (flag.proposed !== undefined) {
      log(`  ${flag.name}: <unset> -> ${flag.proposed}`);
    } else {
      log(`  ${flag.name}: <unset>; shipped default false remains.`);
    }
  }
  log('  Auto-apply settings were not changed; their shipped defaults remain OFF.');
  if (plan.changes.length > 0) {
    log('  Restart KOPENG after applying these .env changes; feature flags are read at server startup.');
  }
}

function commandFor(scriptPath: string, suffix?: string): string {
  const arg = scriptPath.includes(' ') ? `"${scriptPath}"` : scriptPath;
  return `node ${arg}${suffix ? ` ${suffix}` : ''}`;
}

function commandUsesScript(value: unknown, script: string): boolean {
  if (!isObject(value) || typeof value.command !== 'string') return false;
  const command = value.command.replace(/\\/g, '/').toLowerCase();
  return command.includes(`/scripts/hooks/${script.toLowerCase()}`);
}

function resolveApiUrl(claudeConfig: JsonObject, settings: JsonObject, explicit?: string): string {
  if (explicit) return explicit;

  const settingsEnv = isObject(settings.env) ? settings.env : undefined;
  const mcpServers = isObject(claudeConfig.mcpServers) ? claudeConfig.mcpServers : undefined;
  const kopeng = mcpServers && isObject(mcpServers.kopeng) ? mcpServers.kopeng : undefined;
  const mcpEnv = kopeng && isObject(kopeng.env) ? kopeng.env : undefined;
  const hookUrl = typeof settingsEnv?.KOPENG_API_URL === 'string' && settingsEnv.KOPENG_API_URL
    ? settingsEnv.KOPENG_API_URL
    : undefined;
  const mcpUrl = typeof mcpEnv?.MEMORY_API_URL === 'string' && mcpEnv.MEMORY_API_URL
    ? mcpEnv.MEMORY_API_URL
    : undefined;

  if (hookUrl && mcpUrl && hookUrl !== mcpUrl) {
    throw new Error(
      `Existing hook URL (${hookUrl}) and MCP URL (${mcpUrl}) disagree. ` +
      'Re-run with --api-url <url> to choose one; no files were changed.'
    );
  }
  return hookUrl ?? mcpUrl ?? DEFAULT_API_URL;
}

function mergeHook(
  hooks: JsonObject,
  definition: (typeof HOOK_DEFINITIONS)[number],
  repoRoot: string,
  changes: string[]
): void {
  const current = hooks[definition.event];
  if (current !== undefined && !Array.isArray(current)) {
    throw new Error(`hooks.${definition.event} must be an array; no files were changed.`);
  }

  const entries = (current ?? []) as unknown[];
  const scriptPath = posixPath(path.join(repoRoot, 'scripts', 'hooks', definition.script));
  const desiredHook: JsonObject = {
    type: 'command',
    command: commandFor(scriptPath, 'suffix' in definition ? definition.suffix : undefined),
    timeout: definition.timeout,
  };
  const desired: JsonObject = {
    ...('matcher' in definition ? { matcher: definition.matcher } : {}),
    hooks: [desiredHook],
  };

  const expectedMatcher = 'matcher' in definition ? definition.matcher : undefined;
  const matches: Array<{ entryIndex: number; hookIndex: number; compatible: boolean }> = [];
  for (const [entryIndex, entry] of entries.entries()) {
    if (!isObject(entry) || !Array.isArray(entry.hooks)) continue;
    const compatible = expectedMatcher === undefined
      ? entry.matcher === undefined
      : entry.matcher === expectedMatcher;
    for (const [hookIndex, hook] of entry.hooks.entries()) {
      if (commandUsesScript(hook, definition.script)) {
        matches.push({ entryIndex, hookIndex, compatible });
      }
    }
  }

  if (matches.length === 0) {
    changes.push(`add hooks.${definition.event} (${definition.script})`);
    hooks[definition.event] = [...entries, desired];
    return;
  }

  // Prefer an existing group whose matcher already gives this hook the
  // intended scope. Replace only KOPENG's hook object and leave every other
  // command in its original group and position.
  const primary = matches.find(match => match.compatible) ?? matches[0];
  const next: unknown[] = [];
  let inserted = false;
  for (const [entryIndex, entry] of entries.entries()) {
    if (!isObject(entry) || !Array.isArray(entry.hooks)) {
      next.push(entry);
      continue;
    }

    const matchingIndexes = new Set(
      matches.filter(match => match.entryIndex === entryIndex).map(match => match.hookIndex)
    );
    if (matchingIndexes.size === 0) {
      next.push(entry);
      continue;
    }

    if (entryIndex === primary.entryIndex && !primary.compatible) {
      next.push(desired);
      inserted = true;
    }

    const nextHooks: unknown[] = [];
    for (const [hookIndex, hook] of entry.hooks.entries()) {
      if (!matchingIndexes.has(hookIndex)) {
        nextHooks.push(hook);
      } else if (
        entryIndex === primary.entryIndex &&
        hookIndex === primary.hookIndex &&
        primary.compatible
      ) {
        nextHooks.push(desiredHook);
        inserted = true;
      }
    }
    if (nextHooks.length > 0) next.push({ ...entry, hooks: nextHooks });
  }
  if (!inserted) next.push(desired);

  if (JSON.stringify(entries) !== JSON.stringify(next)) {
    const duplicateNote = matches.length > 1 ? `; remove ${matches.length - 1} duplicate(s)` : '';
    changes.push(`update hooks.${definition.event} (${definition.script})${duplicateNote}`);
    hooks[definition.event] = next;
  }
}

function mergeConfigs(
  claudeConfig: JsonObject,
  settings: JsonObject,
  repoRoot: string,
  apiUrl: string
): { claudeConfig: JsonObject; settings: JsonObject; changes: string[] } {
  const nextClaude = clone(claudeConfig);
  const nextSettings = clone(settings);
  const changes: string[] = [];

  const mcpServers = objectField(nextClaude, 'mcpServers', 'mcpServers');
  const existingKopeng = mcpServers.kopeng;
  if (existingKopeng !== undefined && !isObject(existingKopeng)) {
    throw new Error('mcpServers.kopeng must be a JSON object; no files were changed.');
  }
  const kopeng = existingKopeng ? { ...existingKopeng } : {};
  const existingMcpEnv = kopeng.env;
  if (existingMcpEnv !== undefined && !isObject(existingMcpEnv)) {
    throw new Error('mcpServers.kopeng.env must be a JSON object; no files were changed.');
  }
  const nextKopeng: JsonObject = {
    ...kopeng,
    type: 'stdio',
    command: 'node',
    args: [posixPath(path.join(repoRoot, 'dist', 'index.js'))],
    env: { ...(existingMcpEnv ?? {}), MEMORY_API_URL: apiUrl },
  };
  if (JSON.stringify(existingKopeng) !== JSON.stringify(nextKopeng)) {
    changes.push(`${existingKopeng ? 'update' : 'add'} mcpServers.kopeng`);
    mcpServers.kopeng = nextKopeng;
  }

  const settingsEnv = objectField(nextSettings, 'env', 'env');
  if (settingsEnv.KOPENG_API_URL !== apiUrl) {
    changes.push(`${settingsEnv.KOPENG_API_URL === undefined ? 'add' : 'update'} env.KOPENG_API_URL`);
    settingsEnv.KOPENG_API_URL = apiUrl;
  }

  const hooks = objectField(nextSettings, 'hooks', 'hooks');
  for (const definition of HOOK_DEFINITIONS) mergeHook(hooks, definition, repoRoot, changes);

  return { claudeConfig: nextClaude, settings: nextSettings, changes };
}

// Task 2.4.2 — the symmetric reversal of mergeHook: strips every hook whose
// command matches this definition's script (the SAME commandUsesScript
// predicate mergeHook uses to find matches — never a string-guess), then
// collapses whatever that removal leaves behind: a group that held nothing
// but kopeng's hook is dropped entirely (mergeHook creates exactly such a
// group when there was nothing to merge into); a mixed group keeps every
// other hook, in its original order and position.
function removeHookScript(
  hooks: JsonObject,
  definition: (typeof HOOK_DEFINITIONS)[number],
  changes: string[]
): void {
  const current = hooks[definition.event];
  if (!Array.isArray(current)) return;

  let removedCount = 0;
  const nextEntries: unknown[] = [];
  for (const entry of current) {
    if (!isObject(entry) || !Array.isArray(entry.hooks)) {
      nextEntries.push(entry);
      continue;
    }
    const remainingHooks = entry.hooks.filter((hook) => {
      const matches = commandUsesScript(hook, definition.script);
      if (matches) removedCount++;
      return !matches;
    });
    if (remainingHooks.length === 0) continue; // the group held nothing else — drop it
    nextEntries.push(remainingHooks.length === entry.hooks.length ? entry : { ...entry, hooks: remainingHooks });
  }

  if (removedCount === 0) return;
  changes.push(`remove hooks.${definition.event} (${definition.script})`);
  if (nextEntries.length > 0) hooks[definition.event] = nextEntries;
  else delete hooks[definition.event];
}

/**
 * Pure reversal of mergeConfigs: strips mcpServers.kopeng, env.KOPENG_API_URL,
 * and every kopeng-owned hook entry (same ownership predicates mergeConfigs
 * itself uses), then drops any container left empty by that removal so the
 * result matches what the file looked like before kopeng ever touched it —
 * not an empty `{}` husk where a key used to be absent. Entries kopeng does
 * not own are untouched, byte-for-byte, wherever they live.
 */
export function removeConfigs(
  claudeConfig: JsonObject,
  settings: JsonObject
): { claudeConfig: JsonObject; settings: JsonObject; changes: string[] } {
  const nextClaude = clone(claudeConfig);
  const nextSettings = clone(settings);
  const changes: string[] = [];

  const mcpServers = isObject(nextClaude.mcpServers) ? nextClaude.mcpServers : undefined;
  if (mcpServers && Object.prototype.hasOwnProperty.call(mcpServers, 'kopeng')) {
    delete mcpServers.kopeng;
    changes.push('remove mcpServers.kopeng');
    if (Object.keys(mcpServers).length === 0) delete nextClaude.mcpServers;
  }

  const settingsEnv = isObject(nextSettings.env) ? nextSettings.env : undefined;
  if (settingsEnv && Object.prototype.hasOwnProperty.call(settingsEnv, 'KOPENG_API_URL')) {
    delete settingsEnv.KOPENG_API_URL;
    changes.push('remove env.KOPENG_API_URL');
    if (Object.keys(settingsEnv).length === 0) delete nextSettings.env;
  }

  const hooks = isObject(nextSettings.hooks) ? nextSettings.hooks : undefined;
  if (hooks) {
    for (const definition of HOOK_DEFINITIONS) removeHookScript(hooks, definition, changes);
    if (Object.keys(hooks).length === 0) delete nextSettings.hooks;
  }

  return { claudeConfig: nextClaude, settings: nextSettings, changes };
}

export interface WireRemoveOptions {
  homeDir?: string;
  apply?: boolean;
  now?: Date;
  log?: (line: string) => void;
}

export interface WireRemoveResult {
  changed: boolean;
  applied: boolean;
  changes: string[];
  backups: string[];
  claudeConfigPath: string;
  settingsPath: string;
}

/**
 * `kopeng uninstall`'s config-reversal step (Task 2.4.3 calls this). Mirrors
 * wireClient's own shape (dry-run by default, backup-first, atomic writes)
 * but never touches the .env — uninstall's manifest keeps learning-profile
 * flags unless --purge, which removes the whole KOPENG_HOME instead.
 */
export function removeClient(options: WireRemoveOptions = {}): WireRemoveResult {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const log = options.log ?? console.log;
  const claudeConfigPath = path.join(homeDir, '.claude.json');
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');

  const claudeFile = readJsonFile(claudeConfigPath);
  const settingsFile = readJsonFile(settingsPath);
  const removed = removeConfigs(claudeFile.value, settingsFile.value);
  const claudeChanged = JSON.stringify(claudeFile.value) !== JSON.stringify(removed.claudeConfig);
  const settingsChanged = JSON.stringify(settingsFile.value) !== JSON.stringify(removed.settings);
  const changed = claudeChanged || settingsChanged;

  if (!changed) {
    log('No KOPENG entries found in the Claude Code config — nothing to remove.');
    return { changed: false, applied: false, changes: [], backups: [], claudeConfigPath, settingsPath };
  }

  log(`KOPENG entries to remove: ${removed.changes.join(', ')}`);

  if (!options.apply) {
    log('DRY RUN — no files were written.');
    return { changed: true, applied: false, changes: removed.changes, backups: [], claudeConfigPath, settingsPath };
  }

  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const backups: string[] = [];
  for (const file of [claudeFile, settingsFile]) {
    if (!file.exists) continue;
    const destination = backupPath(file.path, stamp);
    fs.copyFileSync(file.path, destination, fs.constants.COPYFILE_EXCL);
    backups.push(destination);
    log(`Backup: ${destination}`);
  }

  if (claudeChanged) writeJsonAtomic(claudeConfigPath, removed.claudeConfig);
  if (settingsChanged) writeJsonAtomic(settingsPath, removed.settings);
  log(`KOPENG client wiring removed (${removed.changes.length} change${removed.changes.length === 1 ? '' : 's'}).`);

  return { changed: true, applied: true, changes: removed.changes, backups, claudeConfigPath, settingsPath };
}

function redactInlineSecrets(value: string): string {
  return value.replace(
    /((?:[A-Z][A-Z0-9_]*_)?(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    '$1<redacted>'
  );
}

function redactValue(value: unknown, counterpart: unknown, key?: string): unknown {
  if (key && /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)) {
    return JSON.stringify(value) === JSON.stringify(counterpart)
      ? '<redacted:unchanged>'
      : '<redacted:updated>';
  }
  if (typeof value === 'string') return redactInlineSecrets(value);
  if (Array.isArray(value)) {
    const other = Array.isArray(counterpart) ? counterpart : [];
    return value.map((entry, index) => redactValue(entry, other[index]));
  }
  if (isObject(value)) {
    const other = isObject(counterpart) ? counterpart : {};
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactValue(child, other[childKey], childKey),
      ])
    );
  }
  return value;
}

function reportValue(value: unknown, counterpart: unknown): string[] {
  if (value === undefined) return ['<missing>'];
  const rendered = JSON.stringify(redactValue(value, counterpart), null, 2);
  return (rendered ?? String(value)).split('\n');
}

function nestedValue(parent: JsonObject, ...keys: string[]): unknown {
  let current: unknown = parent;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function logComparison(
  log: (line: string) => void,
  label: string,
  current: unknown,
  proposed: unknown
): void {
  const changed = JSON.stringify(current) !== JSON.stringify(proposed);
  log(`  ${label} [${changed ? 'changed' : 'unchanged'}]`);
  log('    current:');
  for (const line of reportValue(current, proposed)) log(`      ${line}`);
  log('    proposed:');
  for (const line of reportValue(proposed, current)) log(`      ${line}`);
}

function preservationReport(claudeConfig: JsonObject, settings: JsonObject): string[] {
  const mcpServers = isObject(claudeConfig.mcpServers) ? claudeConfig.mcpServers : {};
  const mcpNames = Object.keys(mcpServers).filter(name => name !== 'kopeng').sort();
  const env = isObject(settings.env) ? settings.env : {};
  const envNames = Object.keys(env).filter(name => name !== 'KOPENG_API_URL').sort();
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const hookCounts = new Map<string, number>();

  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isObject(entry) || !Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
        const managed = HOOK_DEFINITIONS.some(
          definition => definition.event === event && commandUsesScript(hook, definition.script)
        );
        if (!managed) hookCounts.set(event, (hookCounts.get(event) ?? 0) + 1);
      }
    }
  }

  const hookTotal = [...hookCounts.values()].reduce((total, count) => total + count, 0);
  const hookNames = [...hookCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([event, count]) => `${event}=${count}`);
  const names = (values: string[]): string => values.length > 0 ? values.join(', ') : 'none';
  return [
    `Unrelated MCP servers preserved (${mcpNames.length}): ${names(mcpNames)}.`,
    `Unrelated Claude env keys preserved (${envNames.length}): ${names(envNames)}.`,
    `Unrelated hook commands preserved (${hookTotal}): ${names(hookNames)}.`,
  ];
}

function logWiringReport(
  log: (line: string) => void,
  currentClaude: JsonObject,
  currentSettings: JsonObject,
  proposedClaude: JsonObject,
  proposedSettings: JsonObject
): void {
  log('KOPENG client values (current -> proposed):');
  logComparison(
    log,
    'mcpServers.kopeng',
    nestedValue(currentClaude, 'mcpServers', 'kopeng'),
    nestedValue(proposedClaude, 'mcpServers', 'kopeng')
  );
  logComparison(
    log,
    'env.KOPENG_API_URL',
    nestedValue(currentSettings, 'env', 'KOPENG_API_URL'),
    nestedValue(proposedSettings, 'env', 'KOPENG_API_URL')
  );
  for (const definition of HOOK_DEFINITIONS) {
    logComparison(
      log,
      `hooks.${definition.event} (${definition.script})`,
      nestedValue(currentSettings, 'hooks', definition.event),
      nestedValue(proposedSettings, 'hooks', definition.event)
    );
  }
  for (const line of preservationReport(currentClaude, currentSettings)) log(line);
}

function backupPath(filePath: string, stamp: string): string {
  const base = `${filePath}.backup-${stamp}`;
  let candidate = base;
  let suffix = 1;
  while (fs.existsSync(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

function writeJsonAtomic(filePath: string, value: JsonObject): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  // Fix round 2 (Finding 4): carry the target's existing mode across the
  // write-temp-then-rename, exactly as writeTextAtomic below already does —
  // the asymmetry was silent and lossy. ~/.claude.json holds `mcpServers.*.env`
  // API tokens for other services, so an operator who hardened it to 0600 on a
  // shared host must not get it handed back at the umask default (0644) by a
  // routine `kopeng wire --apply` or `kopeng uninstall`.
  const mode = fs.existsSync(filePath) ? fs.statSync(filePath).mode : 0o600;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode });
    fs.renameSync(temporary, filePath);
    try { fs.chmodSync(filePath, mode); } catch { /* Windows / restrictive filesystem */ }
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* no temporary file to clean up */ }
    throw error;
  }
}

function writeTextAtomic(filePath: string, source: string): void {
  // Task 2.2 fix round 1 (finding 1): envFile can now be an arbitrary path
  // (e.g. ~/.kopeng/.env) rather than always `<repoRoot>/.env` with repoRoot
  // already validated to exist — mirror writeJsonAtomic's own mkdir.
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const mode = fs.existsSync(filePath) ? fs.statSync(filePath).mode : 0o600;
  try {
    fs.writeFileSync(temporary, source, { encoding: 'utf8', flag: 'wx', mode });
    fs.renameSync(temporary, filePath);
    try { fs.chmodSync(filePath, mode); } catch { /* Windows / restrictive filesystem */ }
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* no temporary file to clean up */ }
    throw error;
  }
}

export function wireClient(options: WireOptions = {}): WireResult {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const repoRootExplicit = options.repoRootExplicit ?? (options.repoRoot !== undefined);
  const profile = options.profile ?? 'minimal';
  const log = options.log ?? console.log;
  const claudeConfigPath = path.join(homeDir, '.claude.json');
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');

  validateRepoRoot(repoRoot);
  const worktree = linkedWorktreeInfo(repoRoot);
  if (worktree.linked && !repoRootExplicit) {
    for (const line of worktreeMessage(repoRoot, worktree.canonicalRoot)) log(line);
    if (options.apply) {
      throw new Error('Refusing to wire from a linked worktree — these paths may be temporary. No files were changed.');
    }
  }

  // Parse both targets before planning backups or writes. One malformed file
  // must prevent a partial update to the other.
  const claudeFile = readJsonFile(claudeConfigPath);
  const settingsFile = readJsonFile(settingsPath);
  const apiUrl = resolveApiUrl(claudeFile.value, settingsFile.value, options.apiUrl);
  const merged = mergeConfigs(claudeFile.value, settingsFile.value, repoRoot, apiUrl);
  const envFile = options.envFile ?? resolveEnvFile({
    env: options.env ?? process.env,
    projectRoot: repoRoot,
    packagedEnvFile: PACKAGED_ENV_FILE,
  });
  const envPlan = planProfileEnv(envFile, profile);
  const claudeChanged = JSON.stringify(claudeFile.value) !== JSON.stringify(merged.claudeConfig);
  const settingsChanged = JSON.stringify(settingsFile.value) !== JSON.stringify(merged.settings);
  const envChanged = envPlan.source !== envPlan.proposed;
  const changes = [...merged.changes, ...envPlan.changes];
  const changed = claudeChanged || settingsChanged || envChanged;

  logWiringReport(
    log,
    claudeFile.value,
    settingsFile.value,
    merged.claudeConfig,
    merged.settings
  );
  logProfileReport(log, profile, envPlan);

  if (!changed) {
    log(`KOPENG client is already wired and the ${profile} profile needs no changes.`);
    return {
      changed: false,
      applied: false,
      changes: [],
      backups: [],
      claudeConfigPath,
      settingsPath,
    };
  }

  if (!options.apply) {
    log('DRY RUN — no files were written.');
    log(`Claude config: ${claudeConfigPath}`);
    log(`Claude settings: ${settingsPath}`);
    log(`Repo env: ${envPlan.path}`);
    const applyRoot = repoRootExplicit ? repoRoot : worktree.canonicalRoot;
    const rootArg = applyRoot ? ` --repo-root ${cliValue(applyRoot)}` : '';
    const urlArg = options.apiUrl ? ` --api-url ${cliValue(options.apiUrl)}` : '';
    log(`Apply these changes with: npm run wire -- --apply${rootArg}${urlArg} --profile ${profile}`);
    return {
      changed: true,
      applied: false,
      changes,
      backups: [],
      claudeConfigPath,
      settingsPath,
    };
  }

  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const backups: string[] = [];
  const backupFiles = [claudeFile, settingsFile, ...(envChanged ? [envPlan] : [])];
  for (const file of backupFiles) {
    if (!file.exists) continue;
    const destination = backupPath(file.path, stamp);
    fs.copyFileSync(file.path, destination, fs.constants.COPYFILE_EXCL);
    backups.push(destination);
    log(`Backup: ${destination}`);
  }

  if (claudeChanged) writeJsonAtomic(claudeConfigPath, merged.claudeConfig);
  if (settingsChanged) writeJsonAtomic(settingsPath, merged.settings);
  if (envChanged) writeTextAtomic(envPlan.path, envPlan.proposed);
  log(`KOPENG client wiring applied (${changes.length} change${changes.length === 1 ? '' : 's'}).`);

  return {
    changed: true,
    applied: true,
    changes,
    backups,
    claudeConfigPath,
    settingsPath,
  };
}

interface CliOptions {
  apply: boolean;
  apiUrl?: string;
  repoRoot?: string;
  profile?: WireProfile;
}

export function parseWireArgs(args: string[]): CliOptions {
  let apply = false;
  let apiUrl: string | undefined;
  let repoRoot: string | undefined;
  let profile: WireProfile | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--dry-run') {
      apply = false;
    } else if (arg === '--api-url') {
      apiUrl = args[++i];
      if (!apiUrl) throw new Error('--api-url requires a value.');
    } else if (arg === '--repo-root') {
      repoRoot = args[++i];
      if (!repoRoot) throw new Error('--repo-root requires a value.');
    } else if (arg === '--profile') {
      const value = args[++i];
      if (!value) throw new Error('--profile requires minimal, recommended, or everything.');
      if (value !== 'minimal' && value !== 'recommended' && value !== 'everything') {
        throw new Error(`Unknown profile: ${value}. Choose minimal, recommended, or everything.`);
      }
      profile = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { apply, apiUrl, repoRoot, profile };
}

function refuseImplicitWorktreeCliApply(options: CliOptions): void {
  if (!options.apply || options.repoRoot !== undefined) return;
  validateRepoRoot(DEFAULT_REPO_ROOT);
  const worktree = linkedWorktreeInfo(DEFAULT_REPO_ROOT);
  if (!worktree.linked) return;
  for (const line of worktreeMessage(DEFAULT_REPO_ROOT, worktree.canonicalRoot)) console.log(line);
  throw new Error('Refusing to wire from a linked worktree — these paths may be temporary. No files were changed.');
}

// Exported for `kopeng init` (Task 2.2), which reuses this exact chooser
// rather than duplicating the interactive prompt / non-TTY default.
export async function chooseProfile(explicit?: WireProfile): Promise<WireProfile> {
  if (explicit) return explicit;
  if (!process.stdin.isTTY) {
    console.log('Non-interactive stdin detected; using the minimal profile. Pass --profile to choose explicitly.');
    return 'minimal';
  }

  console.log('Choose how KOPENG should work on day one:');
  console.log(`  minimal     — ${PROFILE_DESCRIPTIONS.minimal}`);
  console.log(`  recommended — ${PROFILE_DESCRIPTIONS.recommended}`);
  console.log(`  everything  — ${PROFILE_DESCRIPTIONS.everything}`);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await terminal.question('Profile [recommended]: ')).trim().toLowerCase();
      if (!answer || answer === 'recommended' || answer === '2') return 'recommended';
      if (answer === 'minimal' || answer === '1') return 'minimal';
      if (answer === 'everything' || answer === '3') return 'everything';
      console.log('Choose minimal, recommended, or everything.');
    }
  } finally {
    terminal.close();
  }
}

function isDirectRun(): boolean {
  // Symlink-safe (T72). The obvious argv[1]-vs-import.meta.url comparison
  // reads false through a symlink and this module silently does nothing.
  return isEntrypoint(import.meta.url);
}

if (isDirectRun()) {
  const main = async (): Promise<void> => {
    const options = parseWireArgs(process.argv.slice(2));
    refuseImplicitWorktreeCliApply(options);
    const profile = await chooseProfile(options.profile);
    wireClient({ ...options, profile });
  };
  main().catch(error => {
    console.error(`Wire failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
