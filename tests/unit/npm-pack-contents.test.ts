import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Task 2.1.4 — pins the npm package surface: `npm pack --dry-run` must ship
// exactly the intended runtime files and nothing from a dev-only tree. Like
// the rest of this repo's CI (.github/workflows/ci.yml), this assumes
// `npm run build` already ran — a fresh checkout with no dist/ would fail
// the must-ship assertions below, which is the correct failure (the package
// would genuinely be empty of runtime code).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

interface PackDryRunEntry {
  path: string;
}

function packedFiles(): string[] {
  const output = execFileSync(NPM_BIN, ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // npm.cmd is a batch file — Node's execFileSync needs a shell on Windows
    // to invoke it at all (EINVAL otherwise); the real npm binary on other
    // platforms needs no shell.
    shell: process.platform === 'win32',
  });
  const [pkg] = JSON.parse(output) as [{ files: PackDryRunEntry[] }];
  return pkg.files.map((f) => f.path.split(path.sep).join('/'));
}

const MUST_SHIP = [
  'dist/cli/index.js',
  'dist/cli/wire-client.js',
  'dist/cli/doctor.js',
  'dist/cli/recall-canary.js',
  // `kopeng migrate-anchors` - doctor prescribes this migration to any install
  // that trips legacy_anchor_count > 0, so it MUST be reachable from the
  // tarball (scripts/ops/ is not packed and tsx is a devDependency).
  'dist/cli/migrate-anchors.js',
  'dist/server.js',
  'dist/index.js',
  'dist/version.js',
  'scripts/hooks/kopeng-observe.js',
  'scripts/hooks/memory-prompt-search.mjs',
  'scripts/viz-server.js',
  'viz/index.html',
  '.env.example',
  'SETUP.md',
  'SECURITY.md',
  'docs/codex-setup.md',
  'LICENSE',
  'README.md',
  'CHANGELOG.md',
  'package.json',
];

const MUST_NOT_SHIP_PREFIXES = [
  'data/',
  'logs/',
  'models/',
  'tests/',
  'docs/superpowers/',
  '.superpowers/',
  '.claude/',
];

describe('npm pack contents', () => {
  // One real `npm pack --dry-run` for the whole file — it is the same
  // invocation either test would make, and running it twice roughly doubles
  // wall time for no extra signal.
  let files: string[];
  beforeAll(() => {
    files = packedFiles();
  });

  it('ships the intended runtime surface', () => {
    for (const must of MUST_SHIP) {
      expect(files, `expected "${must}" to be packed`).toContain(must);
    }
  });

  it('never ships data, logs, models, tests, or planning/agent-config directories', () => {
    for (const file of files) {
      for (const prefix of MUST_NOT_SHIP_PREFIXES) {
        expect(file.startsWith(prefix), `"${file}" should not be packed (matches "${prefix}")`).toBe(false);
      }
    }
  });
});
