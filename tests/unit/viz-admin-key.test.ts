/**
 * Viz proxy admin-key resolution (Phase 8, CX-3).
 *
 * The viz proxy and the server's first-run module must resolve ADMIN_API_KEY
 * identically — same parser (dotenv.parse), same precedence (non-empty process
 * env wins, else the file, else ''). The old viz regex took the FIRST match of
 * ^ADMIN_API_KEY=(.*)$ and kept quotes verbatim, so a .env that dotenv reads
 * one way could hand the viz a different key: duplicate assignments (dotenv:
 * last wins), quoted values (dotenv: quotes stripped).
 *
 * Every fixture asserts loadAdminKey(path) === resolveAdminKey(path, env).key
 * — agreement with the shared module IS the contract, in both env states.
 * Temp files only; the repo's live .env is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdminKey } from '../../scripts/viz-server.js';
import { resolveAdminKey } from '../../src/config/first-run.js';

let dir: string;
let savedEnv: string | undefined;
let hadEnv: boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'viz-admin-key-'));
  hadEnv = Object.prototype.hasOwnProperty.call(process.env, 'ADMIN_API_KEY');
  savedEnv = process.env.ADMIN_API_KEY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (hadEnv) process.env.ADMIN_API_KEY = savedEnv;
  else delete process.env.ADMIN_API_KEY;
});

function writeEnvFile(content: string): string {
  const p = join(dir, '.env');
  writeFileSync(p, content, 'utf8');
  return p;
}

const FIXTURES: Array<{ name: string; content: string; expected: string }> = [
  {
    name: 'duplicate ADMIN_API_KEY lines (dotenv: last assignment wins)',
    content: 'ADMIN_API_KEY=firstkey\nADMIN_API_KEY=secondkey\n',
    expected: 'secondkey',
  },
  {
    name: 'double-quoted value (dotenv: quotes stripped)',
    content: 'ADMIN_API_KEY="quotedkey"\n',
    expected: 'quotedkey',
  },
  {
    name: 'CRLF line endings',
    content: 'OTHER_VAR=noise\r\nADMIN_API_KEY=crlfkey\r\n',
    expected: 'crlfkey',
  },
];

describe('loadAdminKey with process.env.ADMIN_API_KEY unset', () => {
  beforeEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  it.each(FIXTURES)('$name: agrees with resolveAdminKey', ({ content, expected }) => {
    const p = writeEnvFile(content);
    const shared = resolveAdminKey(p, process.env.ADMIN_API_KEY);
    expect(shared.key).toBe(expected); // fixture sanity: the shared module reads it this way
    expect(loadAdminKey(p)).toBe(shared.key);
  });

  it('missing file: agrees with resolveAdminKey (empty string)', () => {
    const p = join(dir, 'nope', '.env');
    const shared = resolveAdminKey(p, process.env.ADMIN_API_KEY);
    expect(shared.key).toBe('');
    expect(loadAdminKey(p)).toBe(shared.key);
  });
});

describe('loadAdminKey with process.env.ADMIN_API_KEY set non-empty', () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = 'envwinskey';
  });

  it.each(FIXTURES)('$name: env wins, agrees with resolveAdminKey', ({ content }) => {
    const p = writeEnvFile(content);
    const shared = resolveAdminKey(p, process.env.ADMIN_API_KEY);
    expect(shared.key).toBe('envwinskey');
    expect(loadAdminKey(p)).toBe(shared.key);
  });
});
