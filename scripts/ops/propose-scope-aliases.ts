/**
 * propose-scope-aliases.ts — T46 read-only alias-draft proposer.
 *
 * Fetches the live scope inventory (GET /api/stats → data.by_scope), clusters
 * it into mechanical alias proposals, cross-prefix judgment calls, and
 * ephemeral archive candidates, and writes a JSON + Markdown report for
 * operator review. Writes NOTHING to the server — read-only by construction.
 *
 * The mechanical tier is deliberately conservative: it only merges scope
 * variants that are identical after case/separator normalization (slug
 * equality). Anything requiring a judgment call (cross-prefix collisions,
 * hyphen-insertion near-misses) is surfaced for the operator, never
 * auto-proposed.
 *
 * Usage:  npm run propose:scope-aliases [-- --out <dir>]
 * Env:    MEMORY_API_URL (default http://localhost:3200)
 *
 * Output: <out>/t46-alias-draft.json, <out>/t46-alias-draft.md
 * Load command (operator, after review):
 *   curl -X PATCH $MEMORY_API_URL/api/operator-config \
 *     -H "x-api-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
 *     -d '{"config":{"scope_aliases": <proposal object, hand-edited>}}'
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clusterScopes as clusterScopesImpl } from '../../src/scopes/drift.js';
import type { ProposerReport as Report } from '../../src/scopes/drift.js';

export const API_URL = process.env.MEMORY_API_URL || 'http://localhost:3200';

// ── Clustering (shared with the ops scope-drift detector) ─────────────────
//
// slugifyScope/clusterScopes and the ProposerReport shape live in
// src/scopes/drift.ts so this proposer and GET /api/ops/scope-drift can never
// disagree about what a drift cluster IS. Re-exported here because the unit
// suite and prior callers import them from this path.
export { slugifyScope, clusterScopes } from '../../src/scopes/drift.js';
export type { ProposerReport } from '../../src/scopes/drift.js';

// ── Report writers ───────────────────────────────────────────────────────

function toProposal(mechanical: Report['mechanical']): Record<string, string> {
  const proposal: Record<string, string> = {};
  for (const { canonical, variants } of mechanical) {
    for (const v of variants) proposal[v.scope] = canonical;
  }
  return proposal;
}

function renderMarkdown(report: Report, meta: { generated_at: string; api_url: string; scope_count: number }): string {
  const lines: string[] = [];
  lines.push('# T46 scope-alias draft report');
  lines.push('');
  lines.push(`Generated: ${meta.generated_at}`);
  lines.push(`API: ${meta.api_url}`);
  lines.push(`Total scopes: ${meta.scope_count}`);
  lines.push('');

  lines.push('## Mechanical clusters (ready to review — same slug, safe to alias)');
  lines.push('');
  if (report.mechanical.length === 0) {
    lines.push('_none_');
  } else {
    lines.push('| canonical | variant | variant count |');
    lines.push('|---|---|---|');
    for (const { canonical, variants } of report.mechanical) {
      for (const v of variants) {
        lines.push(`| ${canonical} | ${v.scope} | ${v.count} |`);
      }
    }
  }
  lines.push('');

  lines.push('## Cross-prefix collisions (judgment call — client: and project: share a slug)');
  lines.push('');
  if (report.crossPrefix.length === 0) {
    lines.push('_none_');
  } else {
    lines.push('| slug | scope | count |');
    lines.push('|---|---|---|');
    for (const { slug, scopes } of report.crossPrefix) {
      for (const s of scopes) {
        lines.push(`| ${slug} | ${s.scope} | ${s.count} |`);
      }
    }
  }
  lines.push('');

  lines.push('## Ephemeral scopes (archive candidates — NOT aliases)');
  lines.push('');
  if (report.ephemeral.length === 0) {
    lines.push('_none_');
  } else {
    lines.push('| scope | count | reason |');
    lines.push('|---|---|---|');
    for (const { scope, count, reason } of report.ephemeral) {
      lines.push(`| ${scope} | ${count} | ${reason} |`);
    }
  }
  lines.push('');

  if (report.nearMiss.length > 0) {
    lines.push('## Near-miss slugs (possible, review — same letters after stripping hyphens)');
    lines.push('');
    lines.push('| a | b |');
    lines.push('|---|---|');
    for (const { a, b } of report.nearMiss) {
      lines.push(`| ${a} | ${b} |`);
    }
    lines.push('');
  }

  lines.push(`## Passthrough (already-canonical singletons): ${report.passthrough.length}`);
  lines.push('');

  lines.push('## Loading an approved alias map');
  lines.push('');
  lines.push('This script writes nothing. After hand-editing the `proposal` map in');
  lines.push('`t46-alias-draft.json` (add cross-prefix / near-miss entries you approve,');
  lines.push('drop any you reject), load it with:');
  lines.push('');
  lines.push('```bash');
  lines.push('curl -X PATCH "$MEMORY_API_URL/api/operator-config" \\');
  lines.push('  -H "x-api-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \\');
  lines.push('  -d \'{"config":{"scope_aliases": { "...": "..." }}}\'');
  lines.push('```');
  lines.push('');
  lines.push('Note: `PATCH /api/operator-config` REPLACES the whole `scope_aliases` map');
  lines.push('(T26 shallow top-level merge applies per-key, not per-entry-within-a-key) —');
  lines.push('always resend the FULL map, not just the entries you are adding or changing.');
  lines.push('');

  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { out: string } {
  let out = join(homedir(), '.kopeng', 'reports');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
  }
  return { out };
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));

  const res = await fetch(`${API_URL}/api/stats`);
  if (!res.ok) {
    throw new Error(`GET /api/stats failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const body = await res.json() as { data: { by_scope: Record<string, number> } };
  const byScope = body.data.by_scope ?? {};

  const report = clusterScopesImpl(byScope);
  const generatedAt = new Date().toISOString();
  const scopeCount = Object.keys(byScope).length;

  mkdirSync(out, { recursive: true });

  const jsonArtifact = {
    generated_at: generatedAt,
    api_url: API_URL,
    scope_count: scopeCount,
    proposal: toProposal(report.mechanical),
    crossPrefix: report.crossPrefix,
    ephemeral: report.ephemeral,
    passthrough_count: report.passthrough.length,
    nearMiss: report.nearMiss,
  };

  writeFileSync(join(out, 't46-alias-draft.json'), JSON.stringify(jsonArtifact, null, 2));
  writeFileSync(
    join(out, 't46-alias-draft.md'),
    renderMarkdown(report, { generated_at: generatedAt, api_url: API_URL, scope_count: scopeCount }),
  );

  console.log('\n  KOPENG · T46 scope-alias draft proposer (read-only)');
  console.log(`  api: ${API_URL}   scopes: ${scopeCount}`);
  console.log(`  mechanical clusters: ${report.mechanical.length} (${Object.keys(jsonArtifact.proposal).length} variants)`);
  console.log(`  cross-prefix collisions: ${report.crossPrefix.length}`);
  console.log(`  ephemeral (archive candidates): ${report.ephemeral.length}`);
  console.log(`  passthrough (already canonical): ${report.passthrough.length}`);
  console.log(`  near-miss (review): ${report.nearMiss.length}`);
  console.log(`\n  wrote ${join(out, 't46-alias-draft.json')}`);
  console.log(`  wrote ${join(out, 't46-alias-draft.md')}\n`);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(err => {
    console.error('[propose:scope-aliases] fatal:', err);
    process.exit(1);
  });
}
