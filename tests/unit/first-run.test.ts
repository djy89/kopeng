import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveAdminKey, ensureAdminKey, generateAdminKey, runFirstRunPreflight,
  KeyWriteError, BindRefusedError } from '../../src/config/first-run.js';
import { resolveEnvFile } from '../../src/config/config.js';

let dir: string; let envPath: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-fr-')); envPath = path.join(dir, '.env'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const env = (over = {}) => ({ host: '127.0.0.1', adminApiKey: '', observationApiKey: '', ...over });

describe('resolveAdminKey precedence (CX-3)', () => {
  it('non-empty process.env wins over the file', () => {
    fs.writeFileSync(envPath, 'ADMIN_API_KEY=filekey\n');
    expect(resolveAdminKey(envPath, 'envkey')).toEqual({ key: 'envkey', source: 'env' });
  });
  it('EMPTY process.env does NOT shadow a valid file key (the NSSM case)', () => {
    fs.writeFileSync(envPath, 'ADMIN_API_KEY=filekey\n');
    expect(resolveAdminKey(envPath, '')).toEqual({ key: 'filekey', source: 'file' });
  });
  it('quoted values, duplicates, CRLF, BOM parse via dotenv.parse', () => {
    fs.writeFileSync(envPath, '﻿OTHER=1\r\nADMIN_API_KEY="quoted"\r\nADMIN_API_KEY=second\r\n');
    // dotenv.parse semantics: last assignment wins, quotes stripped
    expect(resolveAdminKey(envPath, undefined).key).toBe('second');
  });
  it('no env, no file → none', () => {
    expect(resolveAdminKey(envPath, undefined)).toEqual({ key: '', source: 'none' });
  });
});

describe('ensureAdminKey writes', () => {
  it('.env absent → created with the generated key', () => {
    const r = ensureAdminKey(envPath, env());
    expect(r.generated).toBe(true);
    expect(fs.readFileSync(envPath, 'utf8')).toContain(`ADMIN_API_KEY=${r.key}`);
    expect(r.key).toMatch(/^[0-9a-f]{64}$/);
  });
  it('existing content is byte-preserved on append', () => {
    fs.writeFileSync(envPath, 'PORT=3200\n# comment\n');
    const r = ensureAdminKey(envPath, env());
    const out = fs.readFileSync(envPath, 'utf8');
    expect(out.startsWith('PORT=3200\n# comment\n')).toBe(true);
    expect(out).toContain(`ADMIN_API_KEY=${r.key}`);
  });
  it('bare ADMIN_API_KEY= line is filled in place, not duplicated', () => {
    fs.writeFileSync(envPath, 'A=1\nADMIN_API_KEY=\nB=2\n');
    const r = ensureAdminKey(envPath, env());
    const out = fs.readFileSync(envPath, 'utf8');
    expect(out.match(/^ADMIN_API_KEY=/gm)).toHaveLength(1);
    expect(out).toContain(`ADMIN_API_KEY=${r.key}`);
    expect(out).toContain('A=1'); expect(out).toContain('B=2');
  });
  it('key already resolvable → exact no-op', () => {
    fs.writeFileSync(envPath, 'ADMIN_API_KEY=already\n');
    const before = fs.readFileSync(envPath, 'utf8');
    const r = ensureAdminKey(envPath, env());
    expect(r).toEqual({ key: 'already', generated: false });
    expect(fs.readFileSync(envPath, 'utf8')).toBe(before);
  });
  // Review finding 3 (defense in depth): a missing PARENT directory is no
  // longer a refusal — the resolved envPath can now legitimately be
  // ~/.kopeng/.env, whose parent a from-source dev/test run has no other
  // reason to have created yet.
  it('creates the parent directory when it does not exist, then writes normally', () => {
    const nestedPath = path.join(dir, 'no-such-dir', 'x', '.env');
    const r = ensureAdminKey(nestedPath, env());
    expect(r.generated).toBe(true);
    expect(fs.readFileSync(nestedPath, 'utf8')).toContain(`ADMIN_API_KEY=${r.key}`);
  });
  it('unwritable path (a FILE occupies a directory segment) → KeyWriteError (boot refusal, never silent-keyless)', () => {
    const blockerFile = path.join(dir, 'blocker');
    fs.writeFileSync(blockerFile, 'not a directory');
    expect(() => ensureAdminKey(path.join(blockerFile, '.env'), env()))
      .toThrow(KeyWriteError);
  });
  it('write is atomic: no .env.tmp survives a successful write', () => {
    ensureAdminKey(envPath, env());
    expect(fs.existsSync(envPath + '.tmp')).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('generated .env is mode 0600 on POSIX', () => {
    ensureAdminKey(envPath, env());
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });
  it.skipIf(process.platform === 'win32')('an EXISTING world-readable .env is tightened to 0600 on key insert', () => {
    fs.writeFileSync(envPath, 'PORT=3200\n', { mode: 0o644 });
    ensureAdminKey(envPath, env());
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });
});

describe('runFirstRunPreflight', () => {
  it('refuses BEFORE generating: non-loopback + missing admin key → BindRefusedError, nothing persisted', () => {
    // Team-review fix: the ADMIN_API_KEY half of the bind refusal must be
    // reachable — the old generate-first ordering silently minted a key and
    // bound wide, so the docs' promised refusal could never fire for it.
    const e = env({ host: '0.0.0.0', observationApiKey: 'obs' });
    expect(() => runFirstRunPreflight(envPath, e)).toThrow(BindRefusedError);
    expect(fs.existsSync(envPath)).toBe(false); // refused boot persists NOTHING
  });
  it('non-loopback with a file-resolvable admin key + obs key boots without regenerating', () => {
    fs.writeFileSync(envPath, 'ADMIN_API_KEY=filekey\n');
    const e = env({ host: '0.0.0.0', observationApiKey: 'obs' });
    const prev = process.env.ADMIN_API_KEY;
    try {
      const r = runFirstRunPreflight(envPath, e);
      expect(r.generated).toBe(false);
      expect(e.adminApiKey).toBe('filekey');
    } finally {
      if (prev === undefined) delete process.env.ADMIN_API_KEY; else process.env.ADMIN_API_KEY = prev;
    }
  });
  it('mutates env object + process.env and never logs the key value', () => {
    const e = env();
    const prev = process.env.ADMIN_API_KEY;
    try {
      delete process.env.ADMIN_API_KEY;
      const r = runFirstRunPreflight(envPath, e);
      expect(r.generated).toBe(true);
      expect(e.adminApiKey).toMatch(/^[0-9a-f]{64}$/);
      expect(process.env.ADMIN_API_KEY).toBe(e.adminApiKey);
    } finally {
      if (prev === undefined) delete process.env.ADMIN_API_KEY; else process.env.ADMIN_API_KEY = prev;
    }
  });
});

// Task 2.3 / Ruling 8 (refines Ruling 7): KOPENG_ENV_FILE (explicit) wins
// outright. Otherwise tier 2 (<projectRoot>/.env) applies whenever that file
// EXISTS **or** projectRoot is not node_modules-resident — so every
// from-source checkout keeps pre-change behavior, .env or not. ~/.kopeng/.env
// is reached ONLY when projectRoot is node_modules-resident (the packaged
// shape, ~/.kopeng/app/node_modules/kopeng) AND has no local .env.
describe('resolveEnvFile (Ruling 8 order)', () => {
  let projectDir: string;
  let packagedProjectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-fr-project-'));
    // Simulates the real packaged shape (~/.kopeng/app/node_modules/kopeng)
    // without needing a real npm install — resolveEnvFile only cares whether
    // a `node_modules` SEGMENT is present in the path string.
    packagedProjectDir = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-fr-home-')), 'app', 'node_modules', 'kopeng'
    );
    fs.mkdirSync(packagedProjectDir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(packagedProjectDir, { recursive: true, force: true });
  });

  it('explicit KOPENG_ENV_FILE wins even when <projectRoot>/.env also exists', () => {
    fs.writeFileSync(path.join(projectDir, '.env'), 'X=1\n');
    const explicit = path.join(dir, 'explicit.env');
    expect(resolveEnvFile({
      env: { KOPENG_ENV_FILE: explicit },
      projectRoot: projectDir,
      packagedEnvFile: path.join(dir, 'packaged.env'),
    })).toBe(explicit);
  });

  it('<projectRoot>/.env wins over the packaged fallback when present, even for a node_modules-resident root', () => {
    const projectEnv = path.join(packagedProjectDir, '.env');
    fs.writeFileSync(projectEnv, 'X=1\n');
    expect(resolveEnvFile({
      env: {},
      projectRoot: packagedProjectDir,
      packagedEnvFile: path.join(dir, 'packaged.env'),
    })).toBe(projectEnv);
  });

  it('a from-source checkout (not node_modules-resident) with NO local .env still resolves to <projectRoot>/.env — never the packaged fallback', () => {
    expect(resolveEnvFile({
      env: {},
      projectRoot: projectDir, // no .env written here, and not inside node_modules
      packagedEnvFile: path.join(dir, 'packaged.env'),
    })).toBe(path.join(projectDir, '.env'));
  });

  it('a node_modules-resident root with NO local .env falls back to the packaged ~/.kopeng/.env', () => {
    const packaged = path.join(dir, 'packaged.env');
    expect(resolveEnvFile({
      env: {},
      projectRoot: packagedProjectDir, // no .env written here, and IS inside node_modules
      packagedEnvFile: packaged,
    })).toBe(packaged);
  });
});

describe('config.ts wires RESOLVED_ENV_FILE end-to-end (module reload)', () => {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
  const ORIGINAL_ENV_FILE = process.env.KOPENG_ENV_FILE;
  const ORIGINAL_HOME = process.env.KOPENG_HOME;
  let fakeHome: string;

  beforeEach(() => { fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kopeng-fr-home-')); });
  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
    if (ORIGINAL_ENV_FILE === undefined) delete process.env.KOPENG_ENV_FILE; else process.env.KOPENG_ENV_FILE = ORIGINAL_ENV_FILE;
    if (ORIGINAL_HOME === undefined) delete process.env.KOPENG_HOME; else process.env.KOPENG_HOME = ORIGINAL_HOME;
    vi.resetModules();
  });

  it('explicit KOPENG_ENV_FILE becomes RESOLVED_ENV_FILE regardless of KOPENG_HOME', async () => {
    const explicit = path.join(fakeHome, 'explicit.env');
    process.env.KOPENG_ENV_FILE = explicit;
    process.env.KOPENG_HOME = fakeHome;
    vi.resetModules();
    const { RESOLVED_ENV_FILE } = await import('../../src/config/config.js');
    expect(RESOLVED_ENV_FILE).toBe(explicit);
  });

  // Review finding 3 regression pin: this checkout's real projectRoot (this
  // worktree) is NOT node_modules-resident, so under Ruling 8 it must resolve
  // to its OWN .env regardless of KOPENG_HOME — never the packaged fallback,
  // even though KOPENG_HOME is set here exactly as it would be on any machine
  // that has ALSO installed the packaged `kopeng` CLI. The old Ruling-7-only
  // logic regressed exactly this: a from-source checkout with no .env yet
  // would target ~/.kopeng/.env (parent may not exist → boot refusal), and a
  // later `cp .env.example .env` would then mint a SECOND admin key at the
  // repo path instead of reusing the one already resolved.
  it('a from-source checkout keeps resolving to its OWN .env even with KOPENG_HOME set (Ruling 8)', async () => {
    // The only precondition this assertion actually needs: the checkout is not
    // node_modules-resident, which is what makes `packaged` false and sends
    // resolveEnvFile down the from-source branch.
    //
    // It used to ALSO assert the repo root carries no `.env`, on the grounds
    // that .gitignore enforces it. It does not: .gitignore stops `.env` being
    // COMMITTED, while every real from-source install has one (`cp .env.example
    // .env` is the documented first step). So the suite passed only on fresh
    // clones and CI runners and was red on any working checkout -- including the
    // operator's own, which is precisely the from-source case under test.
    //
    // Dropping it costs no coverage: resolveEnvFile short-circuits on
    // `!packaged` BEFORE it ever calls existsSync, so for a from-source root the
    // answer is <projectRoot>/.env whether or not the file is there. The
    // no-.env-yet regression this was gesturing at is covered deterministically
    // against a synthetic temp root in the `resolveEnvFile (Ruling 8 order)`
    // block above, which does not depend on the ambient checkout at all.
    expect(REPO_ROOT.toLowerCase()).not.toContain('node_modules');
    delete process.env.KOPENG_ENV_FILE;
    process.env.KOPENG_HOME = fakeHome;
    vi.resetModules();
    const { RESOLVED_ENV_FILE } = await import('../../src/config/config.js');
    expect(RESOLVED_ENV_FILE).toBe(path.join(REPO_ROOT, '.env'));
  });
});
