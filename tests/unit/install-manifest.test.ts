import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { INSTALL_MANIFEST, renderManifest } from '../../src/cli/manifest.js';
import { APP_DIR, DATA_DIR, ENV_FILE, LOGS_DIR, MODELS_DIR } from '../../src/cli/paths.js';

// Task 2.1.2 — the canonical install manifest (Install Strategy §5). Every
// category the brief lists must appear exactly once, and both renderers must
// draw from the SAME array: init's consent screen, uninstall's summary, and
// the future README table are all future consumers, so divergence between
// them is a bug this test exists to catch.
const EXPECTED_ITEM_SUBSTRINGS = [
  'server + CLI',
  'SQLite database',
  'Embedding model',
  'Reranker model',
  'autostart',
  'MCP registration',
  'Learning-profile flags',
];

describe('INSTALL_MANIFEST', () => {
  it('covers every install-strategy category exactly once', () => {
    for (const needle of EXPECTED_ITEM_SUBSTRINGS) {
      const matches = INSTALL_MANIFEST.filter((row) => row.item.includes(needle));
      expect(matches, `expected exactly one row for "${needle}"`).toHaveLength(1);
    }
  });

  it('gives every row a non-empty item/where/size and a boolean removedByUninstall', () => {
    expect(INSTALL_MANIFEST.length).toBeGreaterThan(0);
    for (const row of INSTALL_MANIFEST) {
      expect(row.item.length).toBeGreaterThan(0);
      expect(row.where.length).toBeGreaterThan(0);
      expect(row.size.length).toBeGreaterThan(0);
      expect(typeof row.removedByUninstall).toBe('boolean');
    }
  });

  it('has at least one row removed by uninstall and one kept unless --purge', () => {
    expect(INSTALL_MANIFEST.some((row) => row.removedByUninstall)).toBe(true);
    expect(INSTALL_MANIFEST.some((row) => !row.removedByUninstall)).toBe(true);
  });
});

describe('renderManifest', () => {
  it('renders every manifest row in BOTH the consent and uninstall formats (shared-source pin)', () => {
    const consent = renderManifest('consent');
    const uninstall = renderManifest('uninstall');
    for (const row of INSTALL_MANIFEST) {
      expect(consent, `consent format missing "${row.item}"`).toContain(row.item);
      expect(uninstall, `uninstall format missing "${row.item}"`).toContain(row.item);
    }
  });

  it('distinguishes removed-by-uninstall rows from kept-unless-purge rows', () => {
    const uninstall = renderManifest('uninstall');
    const removedRow = INSTALL_MANIFEST.find((r) => r.removedByUninstall)!;
    const keptRow = INSTALL_MANIFEST.find((r) => !r.removedByUninstall)!;

    const removedIndex = uninstall.indexOf(removedRow.item);
    const keptIndex = uninstall.indexOf(keptRow.item);
    expect(removedIndex).toBeGreaterThanOrEqual(0);
    expect(keptIndex).toBeGreaterThanOrEqual(0);

    const removedBlock = uninstall.slice(removedIndex, removedIndex + 400);
    const keptBlock = uninstall.slice(keptIndex, keptIndex + 400);
    expect(removedBlock).toContain('removed by uninstall');
    expect(keptBlock).toContain('kept unless you pass --purge');
  });

  it('produces different framing text for consent vs. uninstall', () => {
    const consent = renderManifest('consent');
    const uninstall = renderManifest('uninstall');
    expect(consent).not.toBe(uninstall);
    expect(consent.split('\n')[0]).not.toBe(uninstall.split('\n')[0]);
  });
});

// Task 2.6.2 — the THIRD renderer: README.md's "What it puts on your machine"
// table (the other two are init's consent screen and uninstall's summary,
// both pinned above via renderManifest). This is deliberately NOT a byte
// match against renderManifest's output — the README table is hand-written
// prose, free to read well on GitHub — but every manifest category and every
// real on-disk location must still be traceable in it, so a future manifest
// change (a renamed category, a moved directory) fails this test instead of
// silently leaving the README lying. Resilient to prose polish (wording,
// row grouping, column order); strict on manifest content (nouns + paths).
describe('README "What it puts on your machine" table (three-surface pin)', () => {
  const README_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../README.md');
  const readme = readFileSync(README_PATH, 'utf8');

  function extractInstallTable(text: string): string {
    const marker = '## Install';
    const sectionStart = text.indexOf(marker);
    expect(sectionStart, 'README.md is missing an "## Install" section').toBeGreaterThanOrEqual(0);
    const afterMarker = text.slice(sectionStart);
    const headerOffset = afterMarker.indexOf('| Item');
    expect(headerOffset, 'README.md\'s Install section is missing the "What it puts on your machine" table (no "| Item" header found)').toBeGreaterThanOrEqual(0);
    const tableStart = sectionStart + headerOffset;
    const tableEnd = text.indexOf('\n\n', tableStart);
    return text.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);
  }

  const table = extractInstallTable(readme);

  // Finding 4 (fix round): this iterates INSTALL_MANIFEST, NOT the noun list.
  // The old loop walked EXPECTED_ITEM_SUBSTRINGS, so a row ADDED to the
  // manifest was invisible here — the README could omit a whole new install
  // category and this suite, which claims to pin README <-> manifest
  // agreement, stayed green. Driving from the manifest makes an added row a
  // failure in one of two ways: either it maps to no canonical noun (first
  // expect) or its noun is absent from the README table (second).
  it('names every manifest ROW in the README table, via the noun that identifies it (manifest-driven — an ADDED row fails here)', () => {
    for (const row of INSTALL_MANIFEST) {
      const nouns = EXPECTED_ITEM_SUBSTRINGS.filter((needle) => row.item.includes(needle));
      expect(
        nouns,
        `INSTALL_MANIFEST row "${row.item}" matches no canonical noun — add one to EXPECTED_ITEM_SUBSTRINGS and a matching README row`,
      ).not.toHaveLength(0);
      for (const noun of nouns) {
        expect(table, `README install table missing the "${noun}" category (INSTALL_MANIFEST row "${row.item}")`).toContain(noun);
      }
    }
  });

  // Also manifest-driven: the locations come out of each row's own `where`
  // string, so a new row pointing at a new KOPENG_HOME directory is checked
  // without touching this test. The paths.ts constants are still asserted to
  // be REACHED, so a row that stops naming a real install directory fails too.
  it('names the real on-disk location of every KOPENG_HOME-rooted manifest row (parsed out of the rows themselves)', () => {
    const kopengHomePaths = [APP_DIR, DATA_DIR, MODELS_DIR, LOGS_DIR, ENV_FILE];
    const seen = new Set<string>();

    for (const row of INSTALL_MANIFEST) {
      for (const dir of kopengHomePaths) {
        if (!row.where.includes(dir)) continue;
        seen.add(dir);
        const basename = path.basename(dir);
        expect(
          table,
          `README install table missing "${basename}" (from INSTALL_MANIFEST row "${row.item}", where: ${row.where})`,
        ).toContain(basename);
      }
    }

    expect(
      [...seen].sort(),
      'every paths.ts install location should be named by some INSTALL_MANIFEST row',
    ).toEqual([...kopengHomePaths].sort());
  });

  it('names the literal config-file paths the manifest itself specifies for autostart and MCP/hooks (not derived from paths.ts — checked against the manifest\'s own strings so a manifest wording change fails this test, not just a silent README drift)', () => {
    const autostartRow = INSTALL_MANIFEST.find((row) => row.item.includes('autostart'));
    const mcpRow = INSTALL_MANIFEST.find((row) => row.item.includes('MCP registration'));
    expect(autostartRow, 'INSTALL_MANIFEST has no autostart row').toBeDefined();
    expect(mcpRow, 'INSTALL_MANIFEST has no MCP registration row').toBeDefined();

    const autostartPathMatch = autostartRow!.where.match(/~\/[^\s]+/);
    expect(autostartPathMatch, `autostart row's "where" has no literal ~/-path: "${autostartRow!.where}"`).not.toBeNull();
    expect(table).toContain(autostartPathMatch![0]);

    const mcpPaths = mcpRow!.where.split(/\s+and\s+/).map((p) => p.trim());
    expect(mcpPaths.length).toBeGreaterThanOrEqual(2);
    for (const p of mcpPaths) {
      expect(table, `README install table missing MCP/hooks path "${p}"`).toContain(p);
    }
  });
});
