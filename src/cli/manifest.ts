/**
 * THE canonical install manifest (Task 2.1.2, Install Strategy §5) — the
 * single source of truth for what KOPENG puts on a machine and what
 * `uninstall` does and does not remove. Future consumers (init's consent
 * screen, uninstall's summary, the README "what it puts on your machine"
 * table) all render from this SAME array; divergence between them is a bug,
 * which is why `renderManifest` is the only place row text gets formatted.
 */

import { APP_DIR, DATA_DIR, ENV_FILE, LOGS_DIR, MODELS_DIR } from './paths.js';

export interface ManifestRow {
  /** What gets installed/touched. */
  item: string;
  /** Where it lives on disk (or which config file it lives in). */
  where: string;
  /** Rough footprint, for the consent screen. */
  size: string;
  /** true = a plain `uninstall` removes it; false = kept unless --purge. */
  removedByUninstall: boolean;
}

export const INSTALL_MANIFEST: readonly ManifestRow[] = [
  {
    item: 'KOPENG server + CLI',
    where: APP_DIR,
    size: '~150-250 MB (node_modules, including the native SQLite/vector-search dependencies)',
    removedByUninstall: true,
  },
  {
    item: 'Data: SQLite database(s), logs, and .env configuration',
    where: `${DATA_DIR}, ${LOGS_DIR}, ${ENV_FILE}`,
    size: 'starts small; grows with usage',
    removedByUninstall: false,
  },
  {
    item: 'Embedding model (all-MiniLM-L6-v2)',
    where: MODELS_DIR,
    size: '~30 MB',
    removedByUninstall: false,
  },
  {
    item: 'Reranker model (ms-marco-MiniLM-L-6-v2, downloaded on first search)',
    where: MODELS_DIR,
    size: '~90 MB',
    removedByUninstall: false,
  },
  {
    item: 'User-level autostart entry (Scheduled Task / systemd --user unit / LaunchAgent)',
    where: 'platform-specific — recorded in ~/.kopeng/autostart.json',
    size: 'negligible',
    removedByUninstall: true,
  },
  {
    item: 'MCP registration + 5 Claude Code hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, SessionEnd) — your existing config is backed up first',
    where: '~/.claude.json and ~/.claude/settings.json',
    size: 'negligible',
    removedByUninstall: true,
  },
  {
    item: 'Learning-profile flags (OBSERVATION_INGESTION_ENABLED, DISCOVERY_DETECTION_ENABLED, DREAMING_ENABLED)',
    where: ENV_FILE,
    size: 'negligible',
    removedByUninstall: false,
  },
];

export type ManifestFormat = 'consent' | 'uninstall';

/**
 * Renders the manifest as a text block. `consent` frames it as "here's what
 * is about to happen" (init); `uninstall` frames it as "here's what removing
 * KOPENG does and does not touch" (uninstall's summary). Both loop over the
 * SAME array — the shared-source pin `tests/unit/install-manifest.test.ts`
 * relies on.
 */
export function renderManifest(format: ManifestFormat): string {
  const header = format === 'consent'
    ? 'KOPENG will put the following on this machine. Nothing phones home.'
    : 'Uninstalling KOPENG affects the following (pass --purge to also remove everything marked "kept"):';

  const lines = INSTALL_MANIFEST.map((row) => {
    const disposition = row.removedByUninstall
      ? 'removed by uninstall'
      : 'kept unless you pass --purge';
    return `- ${row.item}\n    where: ${row.where}\n    size: ${row.size}\n    on uninstall: ${disposition}`;
  });

  return [header, ...lines].join('\n');
}
