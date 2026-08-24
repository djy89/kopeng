import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveAdminKey, ensureAdminKey, generateAdminKey, runFirstRunPreflight,
  KeyWriteError, BindRefusedError } from '../../src/config/first-run.js';

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
  it('unwritable path → KeyWriteError (boot refusal, never silent-keyless)', () => {
    expect(() => ensureAdminKey(path.join(dir, 'no-such-dir', 'x', '.env'), env()))
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
