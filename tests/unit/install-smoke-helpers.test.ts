import { describe, expect, it } from 'vitest';

import {
  parseTarballArg,
  npmBinaryName,
  buildSandboxEnv,
  withCanaryEnv,
  scanForAdminKey,
  scanClientWiring,
  scanForKopengResidue,
  classifyHealthBody,
  isKopengHealthShape,
  formatStepFailure,
} from '../../scripts/ci/install-smoke.mjs';

// Task 2.5.1 — this file exercises ONLY the pure helpers exported from
// scripts/ci/install-smoke.mjs (no fs/network/spawn access). The script's
// own orchestration (main()) is guarded by an isMain check and is exercised
// by CI / the sanctioned local run, never by vitest — importing this module
// must never execute an install.

describe('parseTarballArg', () => {
  it('reads argv[2] as the tarball path', () => {
    expect(parseTarballArg(['node', 'install-smoke.mjs', '/tmp/kopeng-1.2.3.tgz'])).toBe('/tmp/kopeng-1.2.3.tgz');
  });

  it('throws a usage message when no tarball was given', () => {
    expect(() => parseTarballArg(['node', 'install-smoke.mjs'])).toThrow(/Usage: node scripts\/ci\/install-smoke\.mjs/);
  });
});

describe('npmBinaryName', () => {
  it('is npm.cmd on win32', () => {
    expect(npmBinaryName('win32')).toBe('npm.cmd');
  });

  it('is npm elsewhere', () => {
    expect(npmBinaryName('linux')).toBe('npm');
    expect(npmBinaryName('darwin')).toBe('npm');
  });
});

describe('buildSandboxEnv', () => {
  it('redirects HOME/USERPROFILE/KOPENG_HOME and keeps unrelated keys (PATH) untouched', () => {
    const env = buildSandboxEnv(
      { PATH: '/usr/bin', HOME: '/real/home', USERPROFILE: 'C:\\real\\home' },
      { home: '/sandbox/home', kopengHome: '/sandbox/kopeng-home' }
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/sandbox/home');
    expect(env.USERPROFILE).toBe('/sandbox/home');
    expect(env.KOPENG_HOME).toBe('/sandbox/kopeng-home');
  });

  it('strips ambient KOPENG-related keys that could leak the real install into the sandbox', () => {
    const env = buildSandboxEnv(
      {
        KOPENG_ENV_FILE: '/real/.env',
        PORT: '3200',
        HOST: '0.0.0.0',
        MEMORY_API_URL: 'http://localhost:3200',
        KOPENG_API_URL: 'http://localhost:3200',
        ADMIN_API_KEY: 'real-secret',
        DATABASE_PATH: '/real/memory.db',
        MODELS_CACHE_DIR: '/real/models',
      },
      { home: '/sandbox/home', kopengHome: '/sandbox/kopeng-home' }
    );
    for (const key of [
      'KOPENG_ENV_FILE', 'PORT', 'HOST', 'MEMORY_API_URL',
      'KOPENG_API_URL', 'ADMIN_API_KEY', 'DATABASE_PATH', 'MODELS_CACHE_DIR',
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('never mutates the base env object it was given', () => {
    const base = { PATH: '/usr/bin', HOME: '/real/home' };
    buildSandboxEnv(base, { home: '/sandbox/home', kopengHome: '/sandbox/kopeng-home' });
    expect(base.HOME).toBe('/real/home');
  });
});

describe('withCanaryEnv', () => {
  it('layers KOPENG_API_URL and ADMIN_API_KEY onto an already-sandboxed env', () => {
    const sandboxEnv = { PATH: '/usr/bin', HOME: '/sandbox/home' };
    const env = withCanaryEnv(sandboxEnv, { apiUrl: 'http://localhost:3299', adminKey: 'abc123' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/sandbox/home');
    expect(env.KOPENG_API_URL).toBe('http://localhost:3299');
    expect(env.ADMIN_API_KEY).toBe('abc123');
  });
});

describe('scanForAdminKey', () => {
  it('finds a non-empty ADMIN_API_KEY line', () => {
    const result = scanForAdminKey('PORT=3299\nADMIN_API_KEY=deadbeef1234\nHOST=127.0.0.1\n');
    expect(result).toEqual({ ok: true, adminKey: 'deadbeef1234' });
  });

  it('fails when the key is missing entirely', () => {
    const result = scanForAdminKey('PORT=3299\nHOST=127.0.0.1\n');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no non-empty ADMIN_API_KEY/);
  });

  it('fails when the key is present but empty', () => {
    const result = scanForAdminKey('ADMIN_API_KEY=\nPORT=3299\n');
    expect(result.ok).toBe(false);
  });

  it('trims trailing whitespace/CR from the value', () => {
    const result = scanForAdminKey('ADMIN_API_KEY=deadbeef1234\r\n');
    expect(result).toEqual({ ok: true, adminKey: 'deadbeef1234' });
  });
});

describe('scanClientWiring', () => {
  const claudeJsonWired = JSON.stringify({
    mcpServers: { kopeng: { type: 'stdio', command: 'node', args: ['/sandbox/kopeng-home/app/node_modules/kopeng/dist/index.js'] } },
  });

  function hookGroup(scriptName, matcher) {
    return {
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: `node /sandbox/kopeng-home/app/node_modules/kopeng/scripts/hooks/${scriptName}` }],
    };
  }

  const settingsJsonWired = JSON.stringify({
    hooks: {
      SessionStart: [hookGroup('memory-session-start.mjs', 'startup|resume')],
      UserPromptSubmit: [hookGroup('memory-prompt-search.mjs')],
      PreToolUse: [hookGroup('kopeng-observe.js tool_start')],
      PostToolUse: [hookGroup('kopeng-observe.js tool_complete')],
      SessionEnd: [hookGroup('memory-session-end.mjs')],
    },
  });

  it('reports the MCP entry and all 5 wired hook events on a fully-wired config', () => {
    const result = scanClientWiring(claudeJsonWired, settingsJsonWired);
    expect(result.hasKopengMcp).toBe(true);
    expect(result.hookCount).toBe(5);
    expect(result.wiredEvents).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd']);
  });

  it('reports no MCP entry and zero hooks on empty configs (pre-init)', () => {
    const result = scanClientWiring('{}', '{}');
    expect(result.hasKopengMcp).toBe(false);
    expect(result.hookCount).toBe(0);
  });

  it('degrades to unwired rather than throwing on invalid JSON', () => {
    const result = scanClientWiring('not json', 'also not json');
    expect(result.hasKopengMcp).toBe(false);
    expect(result.hookCount).toBe(0);
  });

  it('counts a partially-wired config correctly (missing one hook event)', () => {
    const settings = JSON.parse(settingsJsonWired);
    delete settings.hooks.SessionEnd;
    const result = scanClientWiring(claudeJsonWired, JSON.stringify(settings));
    expect(result.hookCount).toBe(4);
    expect(result.wiredEvents).not.toContain('SessionEnd');
  });
});

describe('scanForKopengResidue', () => {
  it('finds no residue in fresh (post-uninstall) empty configs', () => {
    expect(scanForKopengResidue('{}', '{}')).toEqual({ hasResidue: false });
  });

  it('detects a leftover mcpServers.kopeng entry', () => {
    const claudeJson = JSON.stringify({ mcpServers: { kopeng: { type: 'stdio' } } });
    expect(scanForKopengResidue(claudeJson, '{}').hasResidue).toBe(true);
  });

  it('detects a leftover kopeng hook command even with an empty mcpServers', () => {
    const settingsJson = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'node /x/scripts/hooks/kopeng-observe.js' }] }] } });
    expect(scanForKopengResidue('{}', settingsJson).hasResidue).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(scanForKopengResidue('{"note":"KOPENG"}', '{}').hasResidue).toBe(true);
  });
});

describe('classifyHealthBody', () => {
  it('accepts status "ready"', () => {
    expect(classifyHealthBody({ data: { status: 'ready' } })).toEqual({ ok: true, status: 'ready' });
  });

  it('accepts status "degraded"', () => {
    expect(classifyHealthBody({ data: { status: 'degraded' } })).toEqual({ ok: true, status: 'degraded' });
  });

  it('rejects an unexpected status, naming it', () => {
    const result = classifyHealthBody({ data: { status: 'loading' } });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('loading');
  });

  it('rejects a missing/malformed body (no response, or wrong shape)', () => {
    expect(classifyHealthBody(null).ok).toBe(false);
    expect(classifyHealthBody({}).ok).toBe(false);
    expect(classifyHealthBody({ data: {} }).ok).toBe(false);
  });
});

describe('formatStepFailure', () => {
  it('names the step and the underlying Error message, no stack trace', () => {
    const message = formatStepFailure('init', new Error('kopeng init exited with code 1'));
    expect(message).toBe("install-smoke FAILED at step 'init': kopeng init exited with code 1");
    expect(message).not.toMatch(/at Object|\.mjs:\d+/);
  });

  it('coerces a non-Error cause to a string', () => {
    expect(formatStepFailure('sandbox', 'plain string reason')).toBe("install-smoke FAILED at step 'sandbox': plain string reason");
  });
});

// Fix round 2 (Finding 1): killLeftoverServer probes /api/health before
// handing the sandbox's ADMIN_API_KEY to whatever holds the port, using this
// predicate as the gate — the same rule src/cli/uninstall.ts's stopServer
// applies. CI-sandbox-only, so the risk is low; the two paths disagreeing
// about who gets an admin key is how the real one would drift back.
describe('isKopengHealthShape', () => {
  it('accepts any {data:{status}} body — a KOPENG server that is not ready is still a KOPENG server', () => {
    expect(isKopengHealthShape({ data: { status: 'ready' } })).toBe(true);
    expect(isKopengHealthShape({ data: { status: 'degraded' } })).toBe(true);
    expect(isKopengHealthShape({ data: { status: 'starting' } })).toBe(true);
  });

  it('rejects what a foreign listener would answer with', () => {
    expect(isKopengHealthShape(null)).toBe(false);
    expect(isKopengHealthShape({})).toBe(false);
    expect(isKopengHealthShape({ status: 'ready' })).toBe(false);
    expect(isKopengHealthShape({ data: {} })).toBe(false);
    expect(isKopengHealthShape('OK')).toBe(false);
  });
});
