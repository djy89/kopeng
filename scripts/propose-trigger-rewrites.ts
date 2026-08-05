/**
 * propose-trigger-rewrites.ts
 *
 * Scans the operator's skill definitions and classifies each trigger description
 * as REACTIVE ("use when asked/told/the user wants…") or OBSERVATIONAL ("use when
 * you observe X"). For every REACTIVE skill, drafts an observational rewrite and
 * emits a before/after Markdown proposal report.
 *
 * Usage:
 *   npx tsx scripts/propose-trigger-rewrites.ts [--dry-run]
 *   npm run propose:triggers
 *
 * Output: docs/chief-of-staff/trigger-rewrite-proposals.md (also printed to stdout)
 *
 * HARD CONSTRAINT: This script NEVER writes to ~/.claude/skills/** or any skill
 * definition file. All fs.writeFileSync calls point exclusively to the proposal
 * report path inside this repo's docs/ directory.
 *
 * Server connectivity (READ-ONLY):
 *   If the KOPENG REST server is reachable at MEMORY_API_URL (default
 *   http://localhost:3200), the script fetches recent sessions to mine usage
 *   signals and improve the observational drafts. Falls back gracefully to
 *   static catalog data when the server is down.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillEntry {
  /** Skill name (human-readable) */
  name: string;
  /** Slash command (e.g. "/handoff") — empty string if unknown */
  command: string;
  /** Current trigger description as found in the skill definition */
  description: string;
  /** Source file path (absolute) */
  source: string;
}

export type TriggerClass = 'reactive' | 'observational' | 'auto-trigger' | 'unknown';

export interface ClassifiedSkill extends SkillEntry {
  triggerClass: TriggerClass;
}

export interface Proposal {
  skill: ClassifiedSkill;
  /** Proposed observational rewrite of the trigger description */
  proposed: string;
  /** One-line rationale for the proposed change */
  rationale: string;
}

// ---------------------------------------------------------------------------
// REACTIVE pattern detection
//
// A description is REACTIVE when it's framed around user intent / user request,
// rather than observable signals the agent can detect autonomously.
// ---------------------------------------------------------------------------

const REACTIVE_PATTERNS: RegExp[] = [
  // "use when asked", "use when the user asks", "use when you're asked"
  /\buse when (?:asked|told|the user (?:asks?|wants?|says?|request|need|invoke)|you(?:'re| are) asked)\b/i,
  // "when the user wants to", "when the user says", "when the user requests"
  /\bwhen the user (?:wants?|says?|ask|request|need|invoke|mention)\b/i,
  // "use for <doing X>" — ambiguous but common in these files; we leave these as-is
  // (only flag the clearly reactive ones to avoid over-flagging)
  // Explicit "Use when asked" at the start of the description
  /^use when (?:asked|told)\b/i,
  // "When asked to", "When told to"
  /^when (?:asked|told) to\b/i,
];

// AUTO-TRIGGER patterns — skills that already fire automatically (not reactive, not fully obs.)
const AUTO_TRIGGER_PATTERNS: RegExp[] = [
  /\bauto.?trigger\b/i,
  /\btrigger(?:s)? on\b/i,
  /ready \(auto\)/i,
  /auto.?fires?\b/i,
  /fires automatically\b/i,
];

// OBSERVATIONAL patterns — already using the right framing
const OBSERVATIONAL_PATTERNS: RegExp[] = [
  /\bwhen you observe\b/i,
  /\bwhen you (?:see|detect|notice|spot)\b/i,
  /\bwhen (?:a|an|the) (?:task|file|command|error|output|pattern|workflow|context)\b/i,
  /\bwhen (?:writing|editing|modifying|working on|building|running|debugging)\b/i,
  /\bwhen (?:any|the) (?:\.yaml|\.xlsx|\.md|script|log|session)/i,
];

export function classifyTrigger(description: string): TriggerClass {
  if (!description || description.trim() === '') return 'unknown';
  const desc = description.trim();
  for (const pat of AUTO_TRIGGER_PATTERNS) {
    if (pat.test(desc)) return 'auto-trigger';
  }
  for (const pat of REACTIVE_PATTERNS) {
    if (pat.test(desc)) return 'reactive';
  }
  for (const pat of OBSERVATIONAL_PATTERNS) {
    if (pat.test(desc)) return 'observational';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Static observational rewrite catalog (operator-local, T35 pattern)
//
// Hand-crafted observational triggers are operator-specific by nature — they
// describe YOUR skills and YOUR workflows — so the shipped default is EMPTY and
// the catalog is merged from an untracked local file:
//   ~/.kopeng/trigger-rewrites.json   (override path: KOPENG_TRIGGER_REWRITES)
// Shape: { "<slug>": { "proposed": "...", "rationale": "..." }, ... }
// Missing/malformed file → empty catalog; the generic rewriter still runs.
//
// Format: slug (lowercased command without "/") → { proposed, rationale }
// ---------------------------------------------------------------------------

interface StaticRewrite {
  proposed: string;
  rationale: string;
}

function loadLocalRewrites(): Record<string, StaticRewrite> {
  const file =
    process.env.KOPENG_TRIGGER_REWRITES ||
    path.join(os.homedir(), '.kopeng', 'trigger-rewrites.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, StaticRewrite> = {};
      for (const [slug, v] of Object.entries(parsed as Record<string, unknown>)) {
        const e = v as Partial<StaticRewrite> | null;
        if (e && typeof e.proposed === 'string' && typeof e.rationale === 'string') {
          out[slug.toLowerCase()] = { proposed: e.proposed, rationale: e.rationale };
        }
      }
      return out;
    }
  } catch {
    // fail-soft: no local catalog
  }
  return {};
}

const STATIC_REWRITES: Record<string, StaticRewrite> = loadLocalRewrites();

// ---------------------------------------------------------------------------
// YAML frontmatter parser (minimal — only needs `description:` field)
// ---------------------------------------------------------------------------

export function extractFrontmatterDescription(content: string): string | null {
  // Match YAML frontmatter block at the top of the file
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fm = match[1];
  // Extract description: value — may span multiple lines (block scalar), but
  // we only need the first line of it for classification purposes.
  const descMatch = fm.match(/^description:\s*(.+)/m);
  if (!descMatch) return null;
  return descMatch[1].trim();
}

// ---------------------------------------------------------------------------
// Skill file readers
// ---------------------------------------------------------------------------

/**
 * Read all skills from ~/.claude/skills/<name>/SKILL.md (frontmatter description: field)
 */
export function readSkillDirSkills(claudeDir: string): SkillEntry[] {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  const entries: SkillEntry[] = [];
  const dirs = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const skillFile = path.join(skillsDir, d.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    const content = fs.readFileSync(skillFile, 'utf-8');
    const description = extractFrontmatterDescription(content);
    if (!description) continue;

    // Extract the name from frontmatter `name:` field or fall back to dir name
    const nameMatch = content.match(/^---\r?\n[\s\S]*?^name:\s*(.+)/m);
    const name = nameMatch ? nameMatch[1].trim() : d.name;

    entries.push({
      name,
      command: `/${d.name}`,
      description,
      source: skillFile,
    });
  }

  return entries;
}

/**
 * Read all skills from ~/.claude/commands/*.md (frontmatter `description:`)
 * Skip files that have no frontmatter description (they have no machine-readable trigger).
 */
export function readCommandSkills(claudeDir: string): SkillEntry[] {
  const commandsDir = path.join(claudeDir, 'commands');
  if (!fs.existsSync(commandsDir)) return [];

  const entries: SkillEntry[] = [];
  const files = fs.readdirSync(commandsDir).filter(f => f.endsWith('.md'));

  for (const file of files) {
    const filePath = path.join(commandsDir, file);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    const description = extractFrontmatterDescription(content);
    if (!description) continue; // no parseable trigger description

    const slug = file.replace(/\.md$/, '');
    // Derive human name from the first H1 in the file, or fall back to slug
    const h1Match = content.match(/^#\s+(.+)/m);
    const name = h1Match ? h1Match[1].trim() : slug;

    entries.push({
      name,
      command: `/${slug}`,
      description,
      source: filePath,
    });
  }

  return entries;
}

/**
 * Parse SKILLS_INDEX.md table for skills that have no frontmatter description
 * in their source files (e.g. sessions.md has no frontmatter at all).
 * Returns a map: slug → { name, command, description } from the Purpose column.
 */
export function readSkillsIndexFallback(claudeDir: string): Map<string, Omit<SkillEntry, 'source'>> {
  const indexPath = path.join(claudeDir, 'SKILLS_INDEX.md');
  if (!fs.existsSync(indexPath)) return new Map();

  const markdown = fs.readFileSync(indexPath, 'utf-8');
  const result = new Map<string, Omit<SkillEntry, 'source'>>();

  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map(c => c.trim());
    if (cells.length < 3) continue;
    // Skip separator rows
    if (cells.every(c => /^[-:\s]*$/.test(c))) continue;
    // Skip header rows
    if (cells[0].toLowerCase() === 'skill') continue;

    // col 0 = skill name, col 1 = command, col 2 = purpose
    const rawName = cells[0].replace(/\*\*/g, '').replace(/⭐/gu, '').trim();
    const command = cells[1].trim();
    const purpose = cells[2].trim();

    if (!rawName || !command || !purpose) continue;
    const slug = command.startsWith('/') ? command.slice(1).trim() : rawName.toLowerCase();

    result.set(slug, {
      name: rawName,
      command,
      description: purpose,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Usage signal mining from observation log (READ-ONLY, server optional)
// ---------------------------------------------------------------------------

interface SessionSummary {
  session_id: string;
  tool_names: string[];
}

/**
 * Fetch recent session tool-use patterns from the REST API.
 * Returns null if the server is unreachable — callers degrade gracefully.
 */
async function fetchUsageSignals(
  apiUrl: string,
  apiKey: string,
): Promise<SessionSummary[] | null> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers['X-API-Key'] = apiKey;

    const url = `${apiUrl}/api/observations/sessions?limit=50`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: ctrl.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) return null;

    const body = (await res.json()) as {
      data: Array<{ session_id: string; tool_names: string | string[] }>;
    };

    return body.data.map(s => ({
      session_id: s.session_id,
      // tool_names is a comma-joined string in SQLite, native array in PG
      tool_names: Array.isArray(s.tool_names)
        ? s.tool_names
        : String(s.tool_names ?? '').split(',').filter(Boolean),
    }));
  } catch {
    return null;
  }
}

/**
 * Given usage signals, identify which skill slugs are actually being invoked
 * (tool_names may include Skill invocations captured as tool calls).
 * Returns a Set of observed skill slugs.
 */
function extractObservedSkillSlugs(sessions: SessionSummary[]): Set<string> {
  const observed = new Set<string>();
  for (const s of sessions) {
    for (const tool of s.tool_names) {
      const lower = tool.toLowerCase();
      // Skill invocations often appear as "Skill" tool with the skill name
      if (lower.startsWith('skill:')) {
        observed.add(lower.slice(6).trim());
      }
      // Or the tool name is the command slug directly
      if (lower.startsWith('/')) {
        observed.add(lower.slice(1).trim());
      }
    }
  }
  return observed;
}

// ---------------------------------------------------------------------------
// Rewrite drafting
//
// For each reactive skill, we:
// 1. Check STATIC_REWRITES first (hand-crafted, always authoritative).
// 2. If no static rewrite exists, emit a best-effort generic observational
//    rewrite derived from the skill's description + usage signals.
// ---------------------------------------------------------------------------

function draftRewrite(skill: ClassifiedSkill, observedSlugs: Set<string>): Proposal {
  const slug = skill.command.startsWith('/') ? skill.command.slice(1) : skill.command;
  const wasObserved = observedSlugs.has(slug.toLowerCase());

  // 1. Static catalog
  const staticEntry = STATIC_REWRITES[slug.toLowerCase()];
  if (staticEntry) {
    const rationale = wasObserved
      ? staticEntry.rationale +
        ' (Confirmed: this skill has been observed in recent session activity.)'
      : staticEntry.rationale;
    return { skill, proposed: staticEntry.proposed, rationale };
  }

  // 2. Generic best-effort rewrite: transform the reactive description into an
  //    observational one by replacing the reactive framing with "when you observe X".
  let proposed = skill.description;
  // Replace "Use when the user wants to X" → "Use when you observe X in progress or requested"
  proposed = proposed.replace(
    /\buse when the user (?:wants? to|asks? to|says? they want to|need to)\s+/gi,
    'Use when you observe the operator actively ',
  );
  // Replace "Use when asked to X" → "Use when you observe X"
  proposed = proposed.replace(
    /\buse when (?:asked|told) to\s+/gi,
    'Use when you observe a need to ',
  );
  // Replace "Use when the user says/mentions X"
  proposed = proposed.replace(
    /\buse when the user (?:says?|mentions?)\s+/gi,
    'Use when the operator mentions or implies ',
  );
  // Replace leading "Use when asked" → "Use when you observe a direct request for"
  proposed = proposed.replace(/^use when asked\b/i, 'Use when you observe a direct request for');

  // Append observation hint if confirmed in session activity
  const observationNote = wasObserved
    ? ' [Usage confirmed in recent sessions — surfacing proactively is appropriate.]'
    : ' [No recent observation log hits — surface conservatively until confirmed.]';

  const rationale = wasObserved
    ? `Observed in recent session activity; reframing from user-intent to agent-observable context signals enables proactive invocation.`
    : `Description is phrased as a user-request gate; reframing as an observable context signal enables the agent to surface it proactively without waiting for explicit invocation.`;

  return {
    skill,
    proposed: proposed + observationNote,
    rationale,
  };
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function buildReport(
  proposals: Proposal[],
  skipped: ClassifiedSkill[],
  serverReachable: boolean,
): string {
  const now = new Date().toISOString().split('T')[0];
  const lines: string[] = [];

  lines.push('# Trigger Rewrite Proposals — C1.5');
  lines.push('');
  lines.push(`> Generated: ${now}  `);
  lines.push(
    `> Usage signals: ${serverReachable ? 'server reachable — mined from /api/observations/sessions' : 'server unreachable — static catalog only (degrade-graceful)'}  `,
  );
  lines.push(`> Total reactive skills found: **${proposals.length}**  `);
  lines.push(`> Already observational / auto-trigger / unknown: **${skipped.length}**`);
  lines.push('');
  lines.push(
    '**Operator action required.** Review each proposal below and apply accepted rewrites',
  );
  lines.push(
    'to `~/.claude/skills/<name>/SKILL.md` or `~/.claude/commands/<name>.md` via your',
  );
  lines.push(
    'normal skill-editing flow. This file is a read-only proposal — no skill file was modified.',
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  if (proposals.length === 0) {
    lines.push('_No reactive skills found. All operator-controlled skills are already observational._');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Before / After Proposals');
  lines.push('');
  lines.push(
    '> For each skill: **CURRENT** = existing description trigger; **PROPOSED** = observational rewrite;',
  );
  lines.push('> **RATIONALE** = why this change improves proactive surfacing.');
  lines.push('');

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    const slug = p.skill.command.startsWith('/') ? p.skill.command.slice(1) : p.skill.command;

    lines.push(`### ${i + 1}. ${p.skill.name} (\`${p.skill.command}\`)`);
    lines.push('');
    lines.push(`**Source:** \`${p.skill.source}\``);
    lines.push('');
    lines.push('**CURRENT (reactive):**');
    lines.push('');
    lines.push(`> ${p.skill.description}`);
    lines.push('');
    lines.push('**PROPOSED (observational):**');
    lines.push('');
    lines.push(`> ${p.proposed}`);
    lines.push('');
    lines.push(`**RATIONALE:** ${p.rationale}`);
    lines.push('');
    lines.push('<details>');
    lines.push('<summary>How to apply this rewrite</summary>');
    lines.push('');
    if (p.skill.source.includes(`${path.sep}skills${path.sep}`)) {
      lines.push(`Edit the \`description:\` field in \`${p.skill.source}\`:`);
      lines.push('');
      lines.push('```yaml');
      lines.push('---');
      lines.push(`name: ${slug}`);
      lines.push(`description: ${p.proposed}`);
      lines.push('---');
      lines.push('```');
    } else {
      lines.push(`Edit the \`description:\` field in \`${p.skill.source}\`:`);
      lines.push('');
      lines.push('```yaml');
      lines.push('---');
      lines.push(`description: ${p.proposed}`);
      lines.push('---');
      lines.push('```');
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Summary table of skipped skills
  if (skipped.length > 0) {
    lines.push('## Skills Already Observational (no change needed)');
    lines.push('');
    lines.push('| Skill | Command | Classification |');
    lines.push('|-------|---------|----------------|');
    for (const s of skipped) {
      const cls =
        s.triggerClass === 'auto-trigger'
          ? 'auto-trigger (fires automatically)'
          : s.triggerClass === 'observational'
            ? 'already observational'
            : 'unknown / no frontmatter';
      lines.push(`| ${s.name} | \`${s.command}\` | ${cls} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('_End of proposal. Apply accepted rewrites as operator-action. This script never modifies skill files._');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const API_URL = process.env.MEMORY_API_URL ?? 'http://localhost:3200';
const API_KEY = process.env.KOPENG_API_KEY ?? '';
const DRY_RUN = process.argv.includes('--dry-run');

// Output path: inside this repo's docs/ — NEVER inside ~/.claude/skills/**
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const OUTPUT_PATH = path.join(REPO_ROOT, 'docs', 'chief-of-staff', 'trigger-rewrite-proposals.md');

function isDirectRun(): boolean {
  const entry = (process.argv[1] ?? '').replace(/\\/g, '/').toLowerCase();
  return (
    entry.endsWith('/propose-trigger-rewrites.ts') ||
    entry.endsWith('/propose-trigger-rewrites.js') ||
    entry.includes('propose-trigger-rewrites')
  );
}

async function main(): Promise<void> {
  console.log('propose-trigger-rewrites: scanning operator skill definitions');
  console.log(`  API URL:   ${API_URL}`);
  console.log(`  Dry run:   ${DRY_RUN}`);
  console.log(`  Output:    ${OUTPUT_PATH}`);
  console.log('');

  const claudeDir = path.join(os.homedir(), '.claude');

  // 1. Read skill definitions from SKILL.md files and commands/
  const skillDirSkills = readSkillDirSkills(claudeDir);
  const commandSkills = readCommandSkills(claudeDir);

  console.log(`  SKILL.md skills found:   ${skillDirSkills.length}`);
  console.log(`  commands/*.md with desc: ${commandSkills.length}`);

  // 2. Read SKILLS_INDEX fallback for any skills without frontmatter descriptions
  const indexFallback = readSkillsIndexFallback(claudeDir);
  console.log(`  SKILLS_INDEX entries:    ${indexFallback.size}`);

  // Build deduplicated skill map (prefer SKILL.md > commands/ > index fallback)
  const skillMap = new Map<string, SkillEntry>();

  // Start with index fallback (lowest priority)
  for (const [slug, entry] of indexFallback) {
    const commandsPath = path.join(claudeDir, 'commands', `${slug}.md`);
    skillMap.set(slug, {
      ...entry,
      source: fs.existsSync(commandsPath)
        ? commandsPath
        : path.join(claudeDir, 'SKILLS_INDEX.md'),
    });
  }

  // Override with command skills (frontmatter descriptions)
  for (const entry of commandSkills) {
    const slug = entry.command.startsWith('/') ? entry.command.slice(1) : entry.command;
    skillMap.set(slug, entry);
  }

  // Override with SKILL.md skills (highest priority — explicit frontmatter)
  for (const entry of skillDirSkills) {
    const slug = entry.command.startsWith('/') ? entry.command.slice(1) : entry.command;
    skillMap.set(slug, entry);
  }

  const allSkills = Array.from(skillMap.values());
  console.log(`  Total unique skills:     ${allSkills.length}`);

  // 3. Classify each skill's trigger
  const classified: ClassifiedSkill[] = allSkills.map(s => ({
    ...s,
    triggerClass: classifyTrigger(s.description),
  }));

  const reactive = classified.filter(s => s.triggerClass === 'reactive');
  const nonReactive = classified.filter(s => s.triggerClass !== 'reactive');

  console.log(`\n  Reactive triggers:       ${reactive.length}`);
  console.log(`  Non-reactive:            ${nonReactive.length}`);
  console.log('');

  // 4. Try to fetch usage signals (READ-ONLY, graceful fallback)
  console.log('  Fetching usage signals from observation log...');
  const sessions = await fetchUsageSignals(API_URL, API_KEY);
  const serverReachable = sessions !== null;
  const observedSlugs = sessions ? extractObservedSkillSlugs(sessions) : new Set<string>();

  console.log(
    `  Server:    ${serverReachable ? `reachable (${sessions!.length} sessions fetched)` : 'unreachable — using static catalog only'}`,
  );
  if (observedSlugs.size > 0) {
    console.log(`  Observed skill slugs:    ${[...observedSlugs].join(', ')}`);
  }
  console.log('');

  // 5. Draft observational rewrites for reactive skills
  const proposals: Proposal[] = reactive.map(skill => draftRewrite(skill, observedSlugs));

  // 6. Build the report
  const report = buildReport(proposals, nonReactive, serverReachable);

  // 7. Output
  console.log(report);

  if (!DRY_RUN) {
    // Ensure output directory exists (it's in this repo — never ~/.claude/skills/**)
    const outDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    fs.writeFileSync(OUTPUT_PATH, report, 'utf-8');
    console.log(`\nReport written to: ${OUTPUT_PATH}`);
    console.log('Review the proposals and apply accepted rewrites as operator-action.');
  } else {
    console.log('\n[DRY RUN] Report not written to disk (--dry-run mode).');
    console.log(`Would write to: ${OUTPUT_PATH}`);
  }

  console.log(`\nSummary: ${proposals.length} proposals emitted / ${nonReactive.length} skills already observational/auto-trigger`);
}

if (isDirectRun()) {
  main().catch(err => {
    console.error('propose-trigger-rewrites failed:', err);
    process.exit(1);
  });
}
