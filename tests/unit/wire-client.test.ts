import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseWireArgs, wireClient } from '../../src/cli/wire-client.js';

let homeDir: string;
let repoRoot: string;

function claudePath(): string {
  return path.join(homeDir, '.claude.json');
}

function settingsPath(): string {
  return path.join(homeDir, '.claude', 'settings.json');
}

function envPath(): string {
  return path.join(repoRoot, '.env');
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function createRepo(root: string): void {
  fs.mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"kopeng"}\n', 'utf8');
}

function createLinkedWorktree(root: string, canonicalRoot: string): void {
  createRepo(root);
  createRepo(canonicalRoot);
  const gitDir = path.join(canonicalRoot, '.git', 'worktrees', 'activation-test');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n', 'utf8');
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${gitDir.replace(/\\/g, '/')}\n`, 'utf8');
}

function hookCommands(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  return Object.values(hooks).flatMap(entries =>
    entries.flatMap(entry => (entry.hooks ?? []).map(hook => hook.command ?? ''))
  );
}

function reportedValue(
  label: string,
  claude: Record<string, unknown>,
  settings: Record<string, unknown>
): unknown {
  if (label === 'mcpServers.kopeng') {
    return (claude.mcpServers as Record<string, unknown> | undefined)?.kopeng;
  }
  if (label === 'env.KOPENG_API_URL') {
    return (settings.env as Record<string, unknown> | undefined)?.KOPENG_API_URL;
  }
  const event = /^hooks\.([^ ]+)/.exec(label)?.[1];
  return event ? (settings.hooks as Record<string, unknown> | undefined)?.[event] : undefined;
}

// Task 2.2 fix round 1 (finding 1): wireClient's envFile now defaults via
// resolveEnvFile, which checks env.KOPENG_ENV_FILE FIRST, unconditionally.
// vitest.config.ts pins KOPENG_ENV_FILE globally to a harmless nonexistent
// path for every test (documented there as "tests that specifically exercise
// resolution override or delete this var for their own scope") — this suite
// relies on the pre-existing <repoRoot>/.env placement throughout, so it
// clears the var for its own scope, same convention first-run.test.ts uses.
const ORIGINAL_KOPENG_ENV_FILE = process.env.KOPENG_ENV_FILE;

beforeEach(() => {
  delete process.env.KOPENG_ENV_FILE;
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-wire-home-'));
  repoRoot = path.join(homeDir, 'clone with space');
  createRepo(repoRoot);
});

afterEach(() => {
  if (ORIGINAL_KOPENG_ENV_FILE === undefined) delete process.env.KOPENG_ENV_FILE;
  else process.env.KOPENG_ENV_FILE = ORIGINAL_KOPENG_ENV_FILE;
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('wireClient', () => {
  it('creates a valid five-hook config on a fresh HOME', () => {
    const result = wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });

    expect(result.applied).toBe(true);
    expect(result.backups).toEqual([]);
    const claude = readJson(claudePath());
    const settings = readJson(settingsPath());
    expect((claude.mcpServers as Record<string, unknown>).kopeng).toMatchObject({
      type: 'stdio',
      command: 'node',
      args: [`${repoRoot.replace(/\\/g, '/')}/dist/index.js`],
      env: { MEMORY_API_URL: 'http://localhost:3200' },
    });
    expect((settings.env as Record<string, unknown>).KOPENG_API_URL).toBe('http://localhost:3200');
    expect(hookCommands(settings)).toHaveLength(5);
    expect(hookCommands(settings).every(command => command.includes('"'))).toBe(true);
  });

  it('preserves unrelated settings, env values, MCP servers, and hooks', () => {
    const unrelatedHook = {
      matcher: 'WebSearch|WebFetch',
      hooks: [{ type: 'command', command: 'node /opt/tools/guard.mjs', timeout: 17 }],
      custom: { keep: 'byte-for-byte' },
    };
    writeJson(claudePath(), {
      theme: 'dark',
      mcpServers: { other: { command: 'other' } },
    });
    writeJson(settingsPath(), {
      env: { EXISTING: 'keep-me' },
      permissions: { allow: ['Read'] },
      hooks: { PreToolUse: [unrelatedHook] },
    });

    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });

    const claude = readJson(claudePath());
    const settings = readJson(settingsPath());
    expect(claude.theme).toBe('dark');
    expect((claude.mcpServers as Record<string, unknown>).other).toEqual({ command: 'other' });
    expect(settings.permissions).toEqual({ allow: ['Read'] });
    expect((settings.env as Record<string, unknown>).EXISTING).toBe('keep-me');
    expect((settings.hooks as Record<string, unknown[]>).PreToolUse).toContainEqual(unrelatedHook);
  });

  it('is idempotent and removes duplicate KOPENG entries', () => {
    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });
    const settings = readJson(settingsPath());
    const hooks = settings.hooks as Record<string, unknown[]>;
    hooks.UserPromptSubmit.push(structuredClone(hooks.UserPromptSubmit[0]));
    writeJson(settingsPath(), settings);

    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });
    const messages: string[] = [];
    const second = wireClient({ homeDir, repoRoot, apply: true, log: line => messages.push(line) });

    expect(second.changed).toBe(false);
    expect(messages.join('\n')).toMatch(/already wired/i);
    expect(hookCommands(readJson(settingsPath()))).toHaveLength(5);
  });

  it('leaves an already-correct KOPENG hook inside a mixed group byte-identical', () => {
    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });
    const settings = readJson(settingsPath());
    const promptEntries = (settings.hooks as Record<string, Array<{
      hooks: Array<Record<string, unknown>>;
    }>>).UserPromptSubmit;
    const unrelated = {
      type: 'command',
      command: 'node C:/tools/handoff-autodone.mjs',
      timeout: 5,
    };
    promptEntries[0].hooks.push(unrelated);
    writeJson(settingsPath(), settings);
    const before = fs.readFileSync(settingsPath(), 'utf8');
    const messages: string[] = [];

    const dryRun = wireClient({ homeDir, repoRoot, log: line => messages.push(line) });
    const applied = wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });

    expect(dryRun.changed).toBe(false);
    expect(applied.changed).toBe(false);
    expect(messages.join('\n')).toMatch(/already wired/i);
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(before);
    expect(
      ((readJson(settingsPath()).hooks as Record<string, typeof promptEntries>).UserPromptSubmit)[0].hooks
    ).toEqual([promptEntries[0].hooks[0], unrelated]);
  });

  it('keeps every key reported unchanged structurally identical after apply', () => {
    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });
    const settings = readJson(settingsPath());
    const promptEntries = (settings.hooks as Record<string, Array<{
      hooks: Array<Record<string, unknown>>;
    }>>).UserPromptSubmit;
    promptEntries[0].hooks.push({
      type: 'command',
      command: 'node C:/tools/handoff-autodone.mjs',
      timeout: 5,
    });
    writeJson(settingsPath(), settings);
    const claude = readJson(claudePath());
    ((claude.mcpServers as Record<string, unknown>).kopeng as Record<string, unknown>).command = 'stale-node';
    writeJson(claudePath(), claude);
    const beforeClaude = readJson(claudePath());
    const beforeSettings = readJson(settingsPath());
    const beforeSettingsSource = fs.readFileSync(settingsPath(), 'utf8');
    const messages: string[] = [];

    wireClient({ homeDir, repoRoot, log: line => messages.push(line) });
    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });

    const unchangedLabels = [...messages.join('\n').matchAll(/^  (.+) \[unchanged\]$/gm)]
      .map(match => match[1]);
    const afterClaude = readJson(claudePath());
    const afterSettings = readJson(settingsPath());
    expect(unchangedLabels).toContain('hooks.UserPromptSubmit (memory-prompt-search.mjs)');
    for (const label of unchangedLabels) {
      expect(JSON.stringify(reportedValue(label, afterClaude, afterSettings))).toBe(
        JSON.stringify(reportedValue(label, beforeClaude, beforeSettings))
      );
    }
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(beforeSettingsSource);
  });

  it('reports and applies a stale mixed hook as a full-key in-place update', () => {
    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });
    const settings = readJson(settingsPath());
    const promptEntries = (settings.hooks as Record<string, Array<{
      hooks: Array<Record<string, unknown>>;
    }>>).UserPromptSubmit;
    promptEntries[0].hooks[0].command = 'node C:/old/scripts/hooks/memory-prompt-search.mjs';
    const secret = 'do-not-print-this-hook-token';
    const unrelated = {
      type: 'command',
      command: `node C:/tools/handoff-autodone.mjs SERVICE_TOKEN=${secret}`,
      timeout: 5,
      custom: { keep: true },
    };
    promptEntries[0].hooks.push(unrelated);
    writeJson(settingsPath(), settings);
    const messages: string[] = [];

    wireClient({ homeDir, repoRoot, log: line => messages.push(line) });
    const output = messages.join('\n');
    expect(output).toContain('hooks.UserPromptSubmit (memory-prompt-search.mjs) [changed]');
    expect(output.match(/handoff-autodone\.mjs/g)).toHaveLength(2);
    expect(output).toContain('C:/old/scripts/hooks/memory-prompt-search.mjs');
    expect(output).toContain(`${repoRoot.replace(/\\/g, '/')}/scripts/hooks/memory-prompt-search.mjs`);
    expect(output).not.toContain(secret);
    expect(output).toContain('SERVICE_TOKEN=<redacted>');

    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });
    const written = ((readJson(settingsPath()).hooks as Record<string, typeof promptEntries>)
      .UserPromptSubmit);
    expect(written).toHaveLength(1);
    expect(written[0].hooks).toHaveLength(2);
    expect(written[0].hooks[0].command).toContain(
      `${repoRoot.replace(/\\/g, '/')}/scripts/hooks/memory-prompt-search.mjs`
    );
    expect(written[0].hooks[1]).toEqual(unrelated);
  });

  it('adds an absent KOPENG hook without moving unrelated groups and reports the full key', () => {
    const unrelatedGroups = [
      {
        hooks: [{ type: 'command', command: 'node C:/tools/first.mjs', timeout: 4 }],
        custom: 'first',
      },
      {
        matcher: 'review',
        hooks: [{ type: 'command', command: 'node C:/tools/second.mjs', timeout: 6 }],
        custom: 'second',
      },
    ];
    writeJson(settingsPath(), { hooks: { UserPromptSubmit: unrelatedGroups } });
    const messages: string[] = [];

    wireClient({ homeDir, repoRoot, log: line => messages.push(line) });
    const output = messages.join('\n');
    expect(output).toContain('hooks.UserPromptSubmit (memory-prompt-search.mjs) [changed]');
    expect(output.match(/C:\/tools\/first\.mjs/g)).toHaveLength(2);
    expect(output.match(/C:\/tools\/second\.mjs/g)).toHaveLength(2);

    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });
    const written = (readJson(settingsPath()).hooks as Record<string, unknown[]>)
      .UserPromptSubmit;
    expect(written.slice(0, 2)).toEqual(unrelatedGroups);
    expect(written).toHaveLength(3);
  });

  it('updates stale repo paths in place after the clone moves', () => {
    wireClient({ homeDir, repoRoot, apply: true, log: () => undefined });
    const movedRoot = path.join(homeDir, 'moved-clone');
    createRepo(movedRoot);

    wireClient({ homeDir, repoRoot: movedRoot, apply: true, log: () => undefined });

    const commands = hookCommands(readJson(settingsPath()));
    expect(commands).toHaveLength(5);
    expect(commands.every(command => command.includes(movedRoot.replace(/\\/g, '/')))).toBe(true);
    expect(commands.every(command => !command.includes(repoRoot.replace(/\\/g, '/')))).toBe(true);
  });

  it('refuses invalid JSON before backing up or changing either target', () => {
    const originalClaude = '{"mcpServers":{"other":{}}}\n';
    fs.writeFileSync(claudePath(), originalClaude, 'utf8');
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), '{ definitely not json', 'utf8');

    expect(() => wireClient({ homeDir, repoRoot, apply: true, log: () => undefined }))
      .toThrow(/invalid JSON.*no files were changed/i);
    expect(fs.readFileSync(claudePath(), 'utf8')).toBe(originalClaude);
    expect(fs.readdirSync(homeDir).filter(name => name.includes('.backup-'))).toEqual([]);
  });

  it('defaults to dry-run and writes nothing', () => {
    const messages: string[] = [];
    const result = wireClient({ homeDir, repoRoot, log: line => messages.push(line) });

    expect(result.changed).toBe(true);
    expect(result.applied).toBe(false);
    expect(fs.existsSync(claudePath())).toBe(false);
    expect(fs.existsSync(settingsPath())).toBe(false);
    expect(messages.join('\n')).toContain('DRY RUN');
    expect(messages.join('\n')).toContain(`${repoRoot.replace(/\\/g, '/')}/dist/index.js`);
    expect(messages.join('\n')).toContain('current:');
    expect(messages.join('\n')).toContain('proposed:');
    expect(messages.join('\n')).toContain('npm run wire -- --apply');
  });

  it('keeps the minimal profile at shipped defaults without creating .env', () => {
    const messages: string[] = [];

    wireClient({
      homeDir,
      repoRoot,
      profile: 'minimal',
      apply: true,
      log: line => messages.push(line),
    });

    expect(fs.existsSync(envPath())).toBe(false);
    expect(messages.join('\n')).toContain('Activation profile: minimal');
    expect(messages.join('\n')).toContain('shipped default false remains');
  });

  it('writes only the two passive-learning flags for the recommended profile', () => {
    wireClient({
      homeDir,
      repoRoot,
      profile: 'recommended',
      apply: true,
      log: () => undefined,
    });

    const env = fs.readFileSync(envPath(), 'utf8');
    expect(env).toContain('OBSERVATION_INGESTION_ENABLED=true');
    expect(env).toContain('DISCOVERY_DETECTION_ENABLED=true');
    expect(env).not.toContain('DREAMING_ENABLED=');
    expect(env).not.toMatch(/auto_accept/i);
  });

  it('does not duplicate profile flags on a second recommended apply', () => {
    wireClient({ homeDir, repoRoot, profile: 'recommended', apply: true, log: () => undefined });
    const second = wireClient({
      homeDir,
      repoRoot,
      profile: 'recommended',
      apply: true,
      log: () => undefined,
    });

    const env = fs.readFileSync(envPath(), 'utf8');
    expect(second.changed).toBe(false);
    expect(env.match(/^OBSERVATION_INGESTION_ENABLED=/gm)).toHaveLength(1);
    expect(env.match(/^DISCOVERY_DETECTION_ENABLED=/gm)).toHaveLength(1);
  });

  it('preserves an explicit profile flag and backs up .env before adding another', () => {
    const original = 'CUSTOM_SETTING=keep\nOBSERVATION_INGESTION_ENABLED=false\n';
    fs.writeFileSync(envPath(), original, 'utf8');
    const messages: string[] = [];

    const result = wireClient({
      homeDir,
      repoRoot,
      profile: 'recommended',
      apply: true,
      now: new Date('2026-08-24T13:00:00.000Z'),
      log: line => messages.push(line),
    });

    const env = fs.readFileSync(envPath(), 'utf8');
    expect(env).toContain('OBSERVATION_INGESTION_ENABLED=false');
    expect(env).toContain('DISCOVERY_DETECTION_ENABLED=true');
    expect(env).toContain('CUSTOM_SETTING=keep');
    const envBackup = result.backups.find(file => file.startsWith(`${envPath()}.backup-`));
    expect(envBackup).toBeDefined();
    expect(fs.readFileSync(envBackup!, 'utf8')).toBe(original);
    expect(messages.join('\n')).toContain('existing explicit value "false" preserved');
  });

  it('enables all three profile flags for everything without arming auto-apply', () => {
    const messages: string[] = [];

    wireClient({
      homeDir,
      repoRoot,
      profile: 'everything',
      apply: true,
      log: line => messages.push(line),
    });

    const env = fs.readFileSync(envPath(), 'utf8');
    expect(env).toContain('OBSERVATION_INGESTION_ENABLED=true');
    expect(env).toContain('DISCOVERY_DETECTION_ENABLED=true');
    expect(env).toContain('DREAMING_ENABLED=true');
    expect(env).not.toMatch(/auto_accept/i);
    expect(messages.join('\n')).toContain('their shipped defaults remain OFF');
  });

  it('reports profile changes in dry-run without writing .env', () => {
    const messages: string[] = [];

    wireClient({
      homeDir,
      repoRoot,
      profile: 'recommended',
      log: line => messages.push(line),
    });

    expect(fs.existsSync(envPath())).toBe(false);
    expect(messages.join('\n')).toContain('OBSERVATION_INGESTION_ENABLED: <unset> -> true');
    expect(messages.join('\n')).toContain('Restart KOPENG after applying');
    expect(messages.join('\n')).toContain('--profile recommended');
  });

  // Task 2.2 fix round 1, finding 1: a packaged install's repoRoot is
  // `<appDir>/node_modules/kopeng`, which never ships its own .env — writing
  // profile flags to `<repoRoot>/.env` (the old hardcoded behavior) silently
  // shadows the REAL config at ~/.kopeng/.env. envFile/env now let a caller
  // (kopeng init) redirect the write to the correct target.
  describe('envFile threading (finding 1)', () => {
    it('an explicit envFile wins outright, even though it differs from <repoRoot>/.env', () => {
      const realEnvFile = path.join(homeDir, 'real-kopeng-home', '.env');

      const result = wireClient({
        homeDir,
        repoRoot,
        profile: 'recommended',
        apply: true,
        envFile: realEnvFile,
        log: () => undefined,
      });

      expect(result.applied).toBe(true);
      expect(fs.existsSync(envPath())).toBe(false); // nothing written under repoRoot
      const env = fs.readFileSync(realEnvFile, 'utf8');
      expect(env).toContain('OBSERVATION_INGESTION_ENABLED=true');
    });

    it('with no explicit envFile, an injected env.KOPENG_ENV_FILE is honored (the standalone `wire` default path)', () => {
      const explicitFromEnv = path.join(homeDir, 'from-env-var', '.env');

      wireClient({
        homeDir,
        repoRoot,
        profile: 'recommended',
        apply: true,
        env: { KOPENG_ENV_FILE: explicitFromEnv },
        log: () => undefined,
      });

      expect(fs.existsSync(envPath())).toBe(false);
      const env = fs.readFileSync(explicitFromEnv, 'utf8');
      expect(env).toContain('DISCOVERY_DETECTION_ENABLED=true');
    });

    it('with neither override and a from-source (non-node_modules) repoRoot, still resolves to <repoRoot>/.env — byte-identical to pre-fix behavior', () => {
      wireClient({ homeDir, repoRoot, profile: 'recommended', apply: true, env: {}, log: () => undefined });
      expect(fs.existsSync(envPath())).toBe(true);
    });
  });

  it('refuses an implicit linked-worktree apply before touching either config', () => {
    const linkedRoot = path.join(homeDir, 'temporary-worktree');
    const canonicalRoot = path.join(homeDir, 'canonical-checkout');
    createLinkedWorktree(linkedRoot, canonicalRoot);
    const originalClaude = '{"mcpServers":{"other":{"command":"x"}}}\n';
    const originalSettings = '{"env":{"EXISTING":"yes"},"hooks":{}}\n';
    fs.writeFileSync(claudePath(), originalClaude, 'utf8');
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), originalSettings, 'utf8');
    const messages: string[] = [];

    expect(() => wireClient({
      homeDir,
      repoRoot: linkedRoot,
      repoRootExplicit: false,
      apply: true,
      log: line => messages.push(line),
    })).toThrow(/Refusing to wire from a linked worktree/i);

    expect(fs.readFileSync(claudePath(), 'utf8')).toBe(originalClaude);
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(originalSettings);
    expect(messages.join('\n')).toContain('WARNING:');
    expect(messages.join('\n')).toContain(
      `npm run wire -- --apply --repo-root ${canonicalRoot.replace(/\\/g, '/')}`
    );
  });

  it('warns but permits a dry-run from an implicit linked worktree', () => {
    const linkedRoot = path.join(homeDir, 'temporary-worktree');
    const canonicalRoot = path.join(homeDir, 'canonical-checkout');
    createLinkedWorktree(linkedRoot, canonicalRoot);
    const messages: string[] = [];

    const result = wireClient({
      homeDir,
      repoRoot: linkedRoot,
      repoRootExplicit: false,
      log: line => messages.push(line),
    });

    expect(result.applied).toBe(false);
    expect(messages.join('\n')).toContain('WARNING:');
    expect(messages.join('\n')).toContain(`${linkedRoot.replace(/\\/g, '/')}/dist/index.js`);
    expect(fs.existsSync(claudePath())).toBe(false);
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it('writes only an explicitly selected canonical checkout path', () => {
    const linkedRoot = path.join(homeDir, 'temporary-worktree');
    const canonicalRoot = path.join(homeDir, 'canonical-checkout');
    createLinkedWorktree(linkedRoot, canonicalRoot);

    wireClient({ homeDir, repoRoot: canonicalRoot, apply: true, log: () => undefined });

    const written = `${fs.readFileSync(claudePath(), 'utf8')}\n${fs.readFileSync(settingsPath(), 'utf8')}`;
    expect(written).toContain(`${canonicalRoot.replace(/\\/g, '/')}/dist/index.js`);
    expect(written).not.toContain(linkedRoot.replace(/\\/g, '/'));
    expect(written).not.toContain('temporary-worktree');
  });

  it('redacts secrets and reports preserved MCP, env, and hook counts', () => {
    const secret = 'do-not-print-this-token-value';
    writeJson(claudePath(), {
      mcpServers: {
        kopeng: { env: { MEMORY_API_URL: 'http://old.invalid', SERVICE_TOKEN: secret } },
        alpha: { command: 'alpha' },
        beta: { command: 'beta' },
      },
    });
    writeJson(settingsPath(), {
      env: { EXISTING: 'keep', PRIVATE_KEY: secret },
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'node /tools/guard.mjs' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'node /tools/stop.mjs' }] }],
      },
    });
    const messages: string[] = [];

    wireClient({
      homeDir,
      repoRoot,
      apiUrl: 'http://new.invalid',
      log: line => messages.push(line),
    });

    const output = messages.join('\n');
    expect(output).not.toContain(secret);
    expect(output).toContain('<redacted:unchanged>');
    expect(output).toContain('Unrelated MCP servers preserved (2): alpha, beta.');
    expect(output).toContain('Unrelated Claude env keys preserved (2): EXISTING, PRIVATE_KEY.');
    expect(output).toContain('Unrelated hook commands preserved (2): PreToolUse=1, Stop=1.');
  });

  it('rejects a repo root that is not a KOPENG checkout', () => {
    const invalidRoot = path.join(homeDir, 'not-kopeng');
    fs.mkdirSync(path.join(invalidRoot, 'scripts', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(invalidRoot, 'package.json'), '{"name":"other"}\n', 'utf8');

    expect(() => wireClient({ homeDir, repoRoot: invalidRoot, apply: true, log: () => undefined }))
      .toThrow(/package\.json must have "name": "kopeng".*No files were changed/i);
    expect(fs.existsSync(claudePath())).toBe(false);
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it('backs up both existing files byte-for-byte before applying', () => {
    const originalClaude = '{"mcpServers":{"other":{"command":"x"}}}\n';
    const originalSettings = '{"env":{"EXISTING":"yes"},"hooks":{}}\n';
    fs.writeFileSync(claudePath(), originalClaude, 'utf8');
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), originalSettings, 'utf8');

    const result = wireClient({
      homeDir,
      repoRoot,
      apply: true,
      now: new Date('2026-08-24T12:34:56.789Z'),
      log: () => undefined,
    });

    expect(result.backups).toHaveLength(2);
    expect(fs.readFileSync(result.backups[0], 'utf8')).toBe(originalClaude);
    expect(fs.readFileSync(result.backups[1], 'utf8')).toBe(originalSettings);
  });

  it('requires an explicit URL when existing hook and MCP URLs conflict', () => {
    writeJson(claudePath(), {
      mcpServers: { kopeng: { env: { MEMORY_API_URL: 'http://one.invalid' } } },
    });
    writeJson(settingsPath(), {
      env: { KOPENG_API_URL: 'http://two.invalid' },
    });

    expect(() => wireClient({ homeDir, repoRoot, apply: true, log: () => undefined }))
      .toThrow(/--api-url <url>.*no files were changed/i);
    expect(readJson(claudePath())).toMatchObject({
      mcpServers: { kopeng: { env: { MEMORY_API_URL: 'http://one.invalid' } } },
    });
  });
});

describe('parseWireArgs', () => {
  it('is dry-run by default and accepts an explicit apply URL', () => {
    expect(parseWireArgs([])).toEqual({
      apply: false,
      apiUrl: undefined,
      repoRoot: undefined,
      profile: undefined,
    });
    expect(parseWireArgs([
      '--apply',
      '--api-url',
      'http://example.invalid:3200',
      '--repo-root',
      '/srv/kopeng',
      '--profile',
      'recommended',
    ])).toEqual({
      apply: true,
      apiUrl: 'http://example.invalid:3200',
      repoRoot: '/srv/kopeng',
      profile: 'recommended',
    });
  });

  it('rejects unknown or incomplete arguments', () => {
    expect(() => parseWireArgs(['--wat'])).toThrow(/Unknown argument/);
    expect(() => parseWireArgs(['--api-url'])).toThrow(/requires a value/);
    expect(() => parseWireArgs(['--repo-root'])).toThrow(/requires a value/);
    expect(() => parseWireArgs(['--profile'])).toThrow(/requires minimal/);
    expect(() => parseWireArgs(['--profile', 'maximum'])).toThrow(/Unknown profile/);
  });
});

describe('wire CLI', () => {
  it('uses the child HOME and remains dry-run unless --apply is present', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(process.cwd(), 'src', 'cli', 'wire-client.ts'),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        encoding: 'utf8',
        timeout: 30_000,
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Non-interactive stdin detected; using the minimal profile.');
    expect(result.stdout).toContain('DRY RUN');
    expect(fs.existsSync(claudePath())).toBe(false);
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it('applies the minimal profile without prompting when stdin is not a TTY', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(process.cwd(), 'src', 'cli', 'wire-client.ts'),
        '--apply',
        '--repo-root',
        repoRoot,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        encoding: 'utf8',
        timeout: 30_000,
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Non-interactive stdin detected; using the minimal profile.');
    expect(result.stdout).toContain('Activation profile: minimal');
    expect(fs.existsSync(envPath())).toBe(false);
  });

  it('applies an explicit profile non-interactively in the disposable repo', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(process.cwd(), 'src', 'cli', 'wire-client.ts'),
        '--apply',
        '--repo-root',
        repoRoot,
        '--profile',
        'recommended',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        encoding: 'utf8',
        timeout: 30_000,
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Non-interactive stdin detected');
    expect(fs.readFileSync(envPath(), 'utf8')).toContain('DISCOVERY_DETECTION_ENABLED=true');
  });
});
