import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { removeClient, removeConfigs, wireClient } from '../../src/cli/wire-client.js';

// Task 2.4.2 — the symmetric reversal of mergeConfigs (wire-client.test.ts).
// removeConfigs strips exactly what mergeConfigs would add/update (mcpServers
// .kopeng, env.KOPENG_API_URL, and every hook entry whose command matches a
// kopeng script) using the SAME ownership predicate (commandUsesScript
// against the known script set) — never a string-guess. removeClient is the
// thin executor (backup-first, atomic writes, dry-run) mirroring wireClient's
// own shape.

let homeDir: string;

function claudePath(): string {
  return path.join(homeDir, '.claude.json');
}

function settingsPath(): string {
  return path.join(homeDir, '.claude', 'settings.json');
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

const ORIGINAL_KOPENG_ENV_FILE = process.env.KOPENG_ENV_FILE;

beforeEach(() => {
  delete process.env.KOPENG_ENV_FILE;
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-wire-remove-'));
});

afterEach(() => {
  if (ORIGINAL_KOPENG_ENV_FILE === undefined) delete process.env.KOPENG_ENV_FILE;
  else process.env.KOPENG_ENV_FILE = ORIGINAL_KOPENG_ENV_FILE;
  fs.rmSync(homeDir, { recursive: true, force: true });
});

function createRepo(root: string): void {
  fs.mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"kopeng"}\n', 'utf8');
}

describe('removeConfigs', () => {
  it('strips mcpServers.kopeng and deletes the now-empty mcpServers key', () => {
    const result = removeConfigs({ mcpServers: { kopeng: { command: 'node' } } }, {});
    expect(result.claudeConfig).toEqual({});
    expect(result.changes).toContain('remove mcpServers.kopeng');
  });

  it('preserves other mcpServers entries', () => {
    const result = removeConfigs(
      { mcpServers: { kopeng: { command: 'node' }, other: { command: 'other' } } },
      {}
    );
    expect(result.claudeConfig).toEqual({ mcpServers: { other: { command: 'other' } } });
  });

  it('strips env.KOPENG_API_URL and deletes the now-empty env key', () => {
    const result = removeConfigs({}, { env: { KOPENG_API_URL: 'http://localhost:3200' } });
    expect(result.settings).toEqual({});
    expect(result.changes).toContain('remove env.KOPENG_API_URL');
  });

  it('preserves other env keys', () => {
    const result = removeConfigs(
      {},
      { env: { KOPENG_API_URL: 'http://localhost:3200', EXISTING: 'keep-me' } }
    );
    expect(result.settings).toEqual({ env: { EXISTING: 'keep-me' } });
  });

  it('removes a kopeng hook entry and deletes the now-empty event/hooks keys', () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'node /repo/scripts/hooks/memory-prompt-search.mjs', timeout: 5 }] },
        ],
      },
    };
    const result = removeConfigs({}, settings);
    expect(result.settings).toEqual({});
    expect(result.changes.some((c) => c.includes('memory-prompt-search.mjs'))).toBe(true);
  });

  it('removes only the kopeng hook out of a mixed group, preserving the foreign hook and its position', () => {
    const foreign = { type: 'command', command: 'node /opt/tools/guard.mjs', timeout: 17 };
    const kopeng = { type: 'command', command: 'node /repo/scripts/hooks/kopeng-observe.js tool_start', timeout: 3 };
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: 'WebSearch', hooks: [foreign, kopeng], custom: 'keep-me' }],
      },
    };
    const result = removeConfigs({}, settings);
    expect(result.settings).toEqual({
      hooks: { PreToolUse: [{ matcher: 'WebSearch', hooks: [foreign], custom: 'keep-me' }] },
    });
  });

  it('drops a whole group that held nothing but the kopeng hook, leaving unrelated groups on the same event untouched', () => {
    const unrelatedGroup = { hooks: [{ type: 'command', command: 'node /tools/other.mjs' }] };
    const kopengGroup = { matcher: 'startup|resume', hooks: [{ type: 'command', command: 'node /repo/scripts/hooks/memory-session-start.mjs' }] };
    const settings = { hooks: { SessionStart: [unrelatedGroup, kopengGroup] } };
    const result = removeConfigs({}, settings);
    expect(result.settings).toEqual({ hooks: { SessionStart: [unrelatedGroup] } });
  });

  it('is a no-op (empty changes) on configs with no kopeng entries at all', () => {
    const claude = { mcpServers: { other: { command: 'other' } } };
    const settings = { env: { EXISTING: 'keep' }, hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node /tools/x.mjs' }] }] } };
    const result = removeConfigs(claude, settings);
    expect(result.claudeConfig).toEqual(claude);
    expect(result.settings).toEqual(settings);
    expect(result.changes).toEqual([]);
  });
});

describe('removeClient', () => {
  it('is a clean no-op on never-wired (nonexistent) configs', () => {
    const messages: string[] = [];
    const result = removeClient({ homeDir, apply: true, log: (l) => messages.push(l) });

    expect(result.changed).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.backups).toEqual([]);
    expect(fs.existsSync(claudePath())).toBe(false);
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it('is a clean no-op on existing configs that hold no kopeng entries', () => {
    const originalClaude = '{"mcpServers":{"other":{"command":"x"}}}\n';
    const originalSettings = '{"env":{"EXISTING":"yes"}}\n';
    fs.writeFileSync(claudePath(), originalClaude, 'utf8');
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), originalSettings, 'utf8');

    const result = removeClient({ homeDir, apply: true, log: () => undefined });

    expect(result.changed).toBe(false);
    expect(result.backups).toEqual([]);
    expect(fs.readFileSync(claudePath(), 'utf8')).toBe(originalClaude);
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(originalSettings);
  });

  it('dry-run reports changes but writes nothing', () => {
    const repoRoot = path.join(homeDir, 'repo');
    createRepo(repoRoot);
    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });
    const beforeClaude = fs.readFileSync(claudePath(), 'utf8');
    const beforeSettings = fs.readFileSync(settingsPath(), 'utf8');
    const messages: string[] = [];

    const result = removeClient({ homeDir, log: (l) => messages.push(l) });

    expect(result.changed).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.backups).toEqual([]);
    expect(fs.readFileSync(claudePath(), 'utf8')).toBe(beforeClaude);
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(beforeSettings);
    expect(messages.join('\n')).toContain('DRY RUN');
    expect(messages.join('\n')).toContain('remove mcpServers.kopeng');
  });

  it('names each removed entry in the summary log', () => {
    const repoRoot = path.join(homeDir, 'repo');
    createRepo(repoRoot);
    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });
    const messages: string[] = [];

    removeClient({ homeDir, apply: true, log: (l) => messages.push(l) });

    const output = messages.join('\n');
    expect(output).toContain('remove mcpServers.kopeng');
    expect(output).toContain('remove env.KOPENG_API_URL');
    expect(output).toContain('memory-session-start.mjs');
    expect(output).toContain('memory-prompt-search.mjs');
    expect(output).toContain('kopeng-observe.js');
    expect(output).toContain('memory-session-end.mjs');
  });

  it('backs up both files before removing', () => {
    const repoRoot = path.join(homeDir, 'repo');
    createRepo(repoRoot);
    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });
    const wiredClaude = fs.readFileSync(claudePath(), 'utf8');
    const wiredSettings = fs.readFileSync(settingsPath(), 'utf8');

    const result = removeClient({ homeDir, apply: true, now: new Date('2026-08-29T00:00:00.000Z'), log: () => undefined });

    expect(result.backups).toHaveLength(2);
    const backedUp = result.backups.map((p) => fs.readFileSync(p, 'utf8'));
    expect(backedUp).toContain(wiredClaude);
    expect(backedUp).toContain(wiredSettings);
  });

  it('wire-then-remove round trip leaves both files deep-equal to their pre-wire state, foreign entries untouched', () => {
    const foreignHook = {
      matcher: 'WebSearch|WebFetch',
      hooks: [{ type: 'command', command: 'node /opt/tools/guard.mjs', timeout: 17 }],
      custom: { keep: 'byte-for-byte' },
    };
    const preWireClaude = {
      theme: 'dark',
      mcpServers: { other: { command: 'other' } },
    };
    const preWireSettings = {
      env: { EXISTING: 'keep-me' },
      permissions: { allow: ['Read'] },
      hooks: { PreToolUse: [foreignHook] },
    };
    writeJson(claudePath(), preWireClaude);
    writeJson(settingsPath(), preWireSettings);

    const repoRoot = path.join(homeDir, 'repo');
    createRepo(repoRoot);
    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });
    // Sanity: wiring actually changed something, or this test would be vacuous.
    expect(readJson(claudePath())).not.toEqual(preWireClaude);

    const result = removeClient({ homeDir, apply: true, log: () => undefined });
    expect(result.applied).toBe(true);

    expect(readJson(claudePath())).toEqual(preWireClaude);
    expect(readJson(settingsPath())).toEqual(preWireSettings);
  });

  it('round trip also holds for a mixed PreToolUse group carrying a foreign hook on the SAME event kopeng uses', () => {
    const foreignPreToolUseHook = { type: 'command', command: 'node /opt/tools/guard.mjs', timeout: 17 };
    const preWireSettings = {
      hooks: { PreToolUse: [{ hooks: [foreignPreToolUseHook] }] },
    };
    writeJson(settingsPath(), preWireSettings);

    const repoRoot = path.join(homeDir, 'repo');
    createRepo(repoRoot);
    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });

    removeClient({ homeDir, apply: true, log: () => undefined });

    expect(readJson(settingsPath())).toEqual(preWireSettings);
  });
});

// ── Finding 4: writeJsonAtomic must not reset the target's file mode ───────
//
// It wrote its temp file with no `mode` and renamed over the target, so the
// result took the umask default (typically 0644) — while its sibling
// writeTextAtomic correctly stat'd and re-applied the existing mode. An
// operator on a shared host who hardened ~/.claude.json to 0600 because it
// holds `mcpServers.*.env` API tokens for OTHER services got it handed back
// world-readable by a routine `kopeng wire --apply` or `kopeng uninstall`.

describe('writeJsonAtomic mode preservation (via removeClient)', () => {
  it('leaves the config file\'s mode exactly as it found it', () => {
    const repoRoot = path.join(homeDir, 'repo');
    createRepo(repoRoot);
    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });

    // Harden both files the way an operator on a shared host would.
    fs.chmodSync(claudePath(), 0o600);
    fs.chmodSync(settingsPath(), 0o600);
    const claudeModeBefore = fs.statSync(claudePath()).mode;
    const settingsModeBefore = fs.statSync(settingsPath()).mode;

    const result = removeClient({ homeDir, apply: true, log: () => undefined });
    expect(result.applied).toBe(true);
    // Sanity: the file was actually rewritten, or this test would be vacuous.
    expect(result.changed).toBe(true);

    expect(fs.statSync(claudePath()).mode).toBe(claudeModeBefore);
    expect(fs.statSync(settingsPath()).mode).toBe(settingsModeBefore);
  });

  // The point of the fix is the 0600 VALUE surviving, which only POSIX
  // reports: on Windows chmod only toggles the read-only bit and stat always
  // reads back 0666, so the assertion above is real but weaker there.
  it.skipIf(process.platform === 'win32')('specifically keeps 0600 rather than falling back to the umask default', () => {
    const repoRoot = path.join(homeDir, 'repo');
    createRepo(repoRoot);
    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });
    fs.chmodSync(claudePath(), 0o600);

    removeClient({ homeDir, apply: true, log: () => undefined });

    expect(fs.statSync(claudePath()).mode & 0o777).toBe(0o600);
  });
});
