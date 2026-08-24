/**
 * Pattern synthesizer — the missing pipeline step.
 *
 * Takes raw PatternCandidates from heuristic detection and aggregates
 * related patterns into actionable workflow insights.
 *
 * Instead of storing one memory per tool+input combo ("you read file X"),
 * this groups related patterns by project+category and generates a single
 * synthesized memory per group ("Key reference files: X, Y, Z — these are
 * your orientation files for this project").
 *
 * Zero-cost (template-based, no LLM calls). Runs between detection and storage.
 */

import type { PatternCandidate } from '../types/types.js';

/**
 * Tool category definitions for grouping related patterns.
 */
type ToolCategory = 'file_access' | 'file_mutation' | 'shell_infra' | 'shell_build' | 'shell_git' | 'shell_other' | 'browser' | 'external_api' | 'other';

const FILE_ACCESS_TOOLS = new Set(['Read', 'read_file', 'Glob', 'Grep']);
const FILE_MUTATION_TOOLS = new Set(['Write', 'Edit', 'write_file', 'edit_file']);
const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'terminal']);
const BROWSER_PREFIX = 'mcp__plugin_chrome-devtools';

function categorizeShellCommand(input: string): 'shell_infra' | 'shell_build' | 'shell_git' | 'shell_other' {
  const lower = input.toLowerCase();
  if (lower.includes('aws ') || lower.includes('kubectl ') || lower.includes('docker ') || lower.includes('terraform ')) {
    return 'shell_infra';
  }
  if (lower.includes('npm ') || lower.includes('npx ') || lower.includes('tsc') || lower.includes('vitest') || lower.includes('jest') || lower.includes('esbuild') || lower.includes('webpack')) {
    return 'shell_build';
  }
  if (lower.includes('git ') || lower.includes('gh ')) {
    return 'shell_git';
  }
  return 'shell_other';
}

function categorize(toolName: string, input: string): ToolCategory {
  if (FILE_ACCESS_TOOLS.has(toolName)) return 'file_access';
  if (FILE_MUTATION_TOOLS.has(toolName)) return 'file_mutation';
  if (SHELL_TOOLS.has(toolName)) return categorizeShellCommand(input);
  if (toolName.startsWith(BROWSER_PREFIX)) return 'browser';
  if (toolName.startsWith('mcp__')) return 'external_api';
  return 'other';
}

/**
 * Extract the meaningful part from a tool input for display.
 * E.g., from a Read input, extract the file path; from Bash, extract the command.
 */
function extractDisplayItem(_toolName: string, input: string): string {
  // Try to extract file_path from JSON-like input
  const filePathMatch = input.match(/"file_path"\s*:\s*"([^"]+)"/i);
  if (filePathMatch) {
    // Shorten Windows paths: strip common prefixes
    let path = filePathMatch[1].replace(/\\\\/g, '\\');
    path = path.replace(/^c:\\users\\[^\\]+\\desktop\\apps\\/i, '');
    path = path.replace(/^c:\\users\\[^\\]+\\/i, '~/');
    return path;
  }

  // Try to extract command from Bash input
  const cmdMatch = input.match(/"command"\s*:\s*"([^"]+)"/i);
  if (cmdMatch) {
    let cmd = cmdMatch[1];
    // Trim long commands
    if (cmd.length > 120) cmd = cmd.slice(0, 117) + '...';
    return cmd;
  }

  // Try to extract search pattern from Grep
  const patternMatch = input.match(/"pattern"\s*:\s*"([^"]+)"/i);
  if (patternMatch) {
    const pathCtx = input.match(/"path"\s*:\s*"([^"]+)"/i);
    if (pathCtx) {
      let p = pathCtx[1].replace(/\\\\/g, '\\');
      p = p.replace(/^c:\\users\\[^\\]+\\desktop\\apps\\/i, '');
      return `grep "${patternMatch[1]}" in ${p}`;
    }
    return `grep "${patternMatch[1]}"`;
  }

  // Try to extract glob pattern
  const globMatch = input.match(/"pattern"\s*:\s*"([^"]+)"/i);
  if (globMatch) return `glob: ${globMatch[1]}`;

  // Fallback: truncate raw input
  return input.slice(0, 100);
}

/**
 * Deduplicate display items that refer to the same underlying resource.
 * E.g., multiple reads of the same file should appear once.
 */
function deduplicateItems(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item.toLowerCase().replace(/\\/g, '/');
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(item);
    }
  }
  return result;
}

interface SynthesisGroup {
  category: ToolCategory;
  projectScope: string;
  candidates: PatternCandidate[];
  items: string[];
  totalEvidence: number;
  maxSpanDays: number;
}

/**
 * Category-specific insight generators.
 * Each takes a group and returns synthesized content + description.
 */
const CATEGORY_SYNTHESIZERS: Record<ToolCategory, (group: SynthesisGroup) => { content: string; description: string; tags: string[] }> = {
  file_access: (group) => {
    const items = deduplicateItems(group.items);
    const fileList = items.slice(0, 15).map(f => `  - ${f}`).join('\n');
    const project = group.projectScope.replace('project:', '');
    return {
      content: `Key reference files frequently accessed in ${project}:\n${fileList}\n\nThese files are consistently accessed across sessions, suggesting they are architectural touchpoints or orientation files.`,
      description: `Key reference files for ${project} (${items.length} files across ${group.totalEvidence} accesses)`,
      tags: ['workflow', 'key-files'],
    };
  },

  file_mutation: (group) => {
    const items = deduplicateItems(group.items);
    const fileList = items.slice(0, 15).map(f => `  - ${f}`).join('\n');
    const project = group.projectScope.replace('project:', '');
    return {
      content: `Frequently modified files in ${project}:\n${fileList}\n\nThese are active development hotspots — high-churn files that may benefit from additional test coverage or architectural attention.`,
      description: `High-churn files in ${project} (${items.length} files)`,
      tags: ['workflow', 'hot-files'],
    };
  },

  shell_infra: (group) => {
    const items = deduplicateItems(group.items);
    const cmdList = items.slice(0, 10).map(c => `  - ${c}`).join('\n');
    const project = group.projectScope.replace('project:', '');
    return {
      content: `Infrastructure commands frequently run manually in ${project}:\n${cmdList}\n\nThese are manual operations performed repeatedly across sessions — candidates for automation via CI/CD, scripts, or monitoring dashboards.`,
      description: `Manual infra operations in ${project} — automation candidates`,
      tags: ['workflow', 'infrastructure', 'automation-candidate'],
    };
  },

  shell_build: (group) => {
    const items = deduplicateItems(group.items);
    const cmdList = items.slice(0, 10).map(c => `  - ${c}`).join('\n');
    const project = group.projectScope.replace('project:', '');
    return {
      content: `Build/test verification workflow in ${project}:\n${cmdList}\n\nThese commands are run frequently as quality gates. Consider pre-commit hooks or CI checks if not already automated.`,
      description: `Build/test workflow for ${project}`,
      tags: ['workflow', 'build', 'testing'],
    };
  },

  shell_git: (group) => {
    const items = deduplicateItems(group.items);
    const cmdList = items.slice(0, 10).map(c => `  - ${c}`).join('\n');
    const project = group.projectScope.replace('project:', '');
    return {
      content: `Git/GitHub workflow patterns in ${project}:\n${cmdList}\n\nRecurring git operations that reflect the development workflow for this project.`,
      description: `Git workflow patterns in ${project}`,
      tags: ['workflow', 'git'],
    };
  },

  shell_other: (group) => {
    const items = deduplicateItems(group.items);
    const cmdList = items.slice(0, 10).map(c => `  - ${c}`).join('\n');
    const project = group.projectScope.replace('project:', '');
    return {
      content: `Frequently run commands in ${project}:\n${cmdList}`,
      description: `Recurring commands in ${project}`,
      tags: ['workflow', 'commands'],
    };
  },

  browser: (group) => {
    const project = group.projectScope.replace('project:', '');
    const tools = new Set(group.candidates.map(c => {
      const match = c.content.match(/uses (\S+)/);
      return match ? match[1].replace(BROWSER_PREFIX + '_', '') : 'unknown';
    }));
    const toolList = [...tools].join(', ');
    return {
      content: `Manual browser testing workflow in ${project}: ${toolList}. Performed ${group.totalEvidence} times across sessions.\n\nThis manual verification pattern may benefit from E2E test coverage (Playwright/Cypress) or visual regression testing.`,
      description: `Manual UI testing workflow in ${project} — E2E test candidate`,
      tags: ['workflow', 'testing', 'browser', 'automation-candidate'],
    };
  },

  external_api: (group) => {
    const services = new Set(group.candidates.map(c => {
      const match = c.content.match(/uses (mcp__\S+)/);
      if (!match) return 'unknown';
      // Extract service name: mcp__plugin_linear_linear__get_issue → linear
      const parts = match[1].split('__');
      return parts.length >= 3 ? parts[2] : parts[1] || 'unknown';
    }));
    const project = group.projectScope.replace('project:', '');
    return {
      content: `External services frequently accessed in ${project}: ${[...services].join(', ')}.\n\nThese integrations are actively used in the development workflow for this project.`,
      description: `External service usage in ${project}: ${[...services].join(', ')}`,
      tags: ['workflow', 'integrations'],
    };
  },

  other: (group) => {
    const items = deduplicateItems(group.items);
    const itemList = items.slice(0, 10).map(i => `  - ${i}`).join('\n');
    const project = group.projectScope.replace('project:', '');
    return {
      content: `Recurring tool usage pattern in ${project}:\n${itemList}`,
      description: `Tool usage pattern in ${project}`,
      tags: ['workflow'],
    };
  },
};

// ── Sequence chaining (thin Skills layer) ───────────────────────────────────

interface SequenceEdge {
  candidate: PatternCandidate;
  from: string;
  to: string;
}

/** Build a single multi-step workflow candidate from a chain of bigrams. */
function buildChainCandidate(
  scope: string,
  path: string[],
  members: PatternCandidate[],
): PatternCandidate {
  const chainStr = path.join(' → ');
  // A chain is only as evidenced as its weakest link.
  const sessions = Math.min(...members.map(m => m.distinct_sessions ?? 0));
  return {
    pattern_type: 'sequence',
    description: `Workflow: ${chainStr} (${sessions} sessions)`,
    evidence_count: Math.min(...members.map(m => m.evidence_count)),
    observation_span_days: Math.max(...members.map(m => m.observation_span_days)),
    project_scope: scope,
    confidence: 0, // recomputed by the discovery engine for sequences
    content: `Multi-step workflow detected: ${chainStr}. This ordered sequence of steps recurs across sessions and represents a repeatable procedure.`,
    evidence_snapshot: members.flatMap(m => m.evidence_snapshot).slice(0, 20),
    // The 'skill' tag is applied at storage (discovery-engine) once keyability is
    // confirmed; here we only mark the workflow synthesis.
    synthesized_tags: ['workflow'],
    distinct_sessions: sessions,
    steps: [...path],
  };
}

/**
 * Chain overlapping bigrams (A→B, B→C) into multi-step workflow candidates.
 * Only edges within the same project scope chain. Each bigram is consumed by at
 * most one chain (≥3 nodes); un-chained bigrams are returned as `leftover` and
 * pass through unchanged.
 */
function chainSequences(
  sequences: PatternCandidate[],
): { chained: PatternCandidate[]; leftover: PatternCandidate[] } {
  if (sequences.length < 2) return { chained: [], leftover: sequences };

  const byScope = new Map<string, SequenceEdge[]>();
  for (const candidate of sequences) {
    const steps = candidate.steps;
    if (!steps || steps.length < 2) continue; // only well-formed bigrams chain
    const list = byScope.get(candidate.project_scope) ?? [];
    list.push({ candidate, from: steps[0], to: steps[1] });
    byScope.set(candidate.project_scope, list);
  }

  const chained: PatternCandidate[] = [];
  const consumed = new Set<PatternCandidate>();

  for (const [scope, edges] of byScope) {
    if (edges.length < 2) continue;

    const out = new Map<string, SequenceEdge[]>();
    for (const edge of edges) {
      const list = out.get(edge.from) ?? [];
      list.push(edge);
      out.set(edge.from, list);
    }

    // Prefer real chain starts: a 'from' that is never a 'to'. Fall back to all
    // 'from' nodes if every node has an in-edge (pure cycle).
    const froms = [...new Set(edges.map(e => e.from))];
    const tos = new Set(edges.map(e => e.to));
    const starts = froms.filter(f => !tos.has(f));
    const startNodes = starts.length > 0 ? starts : froms;

    for (const start of startNodes) {
      const path = [start];
      const members: PatternCandidate[] = [];
      const visited = new Set([start]);
      let cur = start;
      while (path.length < 6) {
        const next = (out.get(cur) ?? []).find(
          e => !consumed.has(e.candidate) && !visited.has(e.to),
        );
        if (!next) break;
        path.push(next.to);
        members.push(next.candidate);
        visited.add(next.to);
        cur = next.to;
      }
      if (path.length >= 3) {
        members.forEach(m => consumed.add(m));
        chained.push(buildChainCandidate(scope, path, members));
      }
    }
  }

  const leftover = sequences.filter(c => !consumed.has(c));
  return { chained, leftover };
}

/**
 * Synthesize raw repeated_tool patterns into aggregated, actionable insights,
 * and chain overlapping sequence bigrams into multi-step workflows.
 *
 * Groups repeated_tool candidates by project_scope + tool category, merges them
 * into single synthesized PatternCandidates with actionable content. Sequence
 * candidates are chained (A→B, B→C → A→B→C) into procedural "skill" workflows;
 * un-chained bigrams pass through. Other patterns (error_fix, hot_file,
 * recurring_error) pass through unchanged — they already have meaningful content.
 */
export function synthesizePatterns(candidates: PatternCandidate[]): PatternCandidate[] {
  const passThrough: PatternCandidate[] = [];
  const repeatedToolCandidates: PatternCandidate[] = [];
  const sequenceCandidates: PatternCandidate[] = [];

  for (const c of candidates) {
    if (c.pattern_type === 'repeated_tool') {
      repeatedToolCandidates.push(c);
    } else if (c.pattern_type === 'sequence') {
      sequenceCandidates.push(c);
    } else {
      passThrough.push(c);
    }
  }

  // Chain multi-step workflows; chained + leftover bigrams flow through as-is.
  const { chained, leftover } = chainSequences(sequenceCandidates);
  passThrough.push(...leftover, ...chained);

  if (repeatedToolCandidates.length === 0) return passThrough;

  // Group by project_scope + tool category
  const groups = new Map<string, SynthesisGroup>();

  for (const candidate of repeatedToolCandidates) {
    const toolName = candidate.evidence_snapshot[0]?.tool ?? 'unknown';
    const input = candidate.content;
    const category = categorize(toolName, input);
    const groupKey = `${candidate.project_scope}::${category}`;

    const existing = groups.get(groupKey);
    const displayItem = extractDisplayItem(toolName, input);

    if (existing) {
      existing.candidates.push(candidate);
      existing.items.push(displayItem);
      existing.totalEvidence += candidate.evidence_count;
      existing.maxSpanDays = Math.max(existing.maxSpanDays, candidate.observation_span_days);
    } else {
      groups.set(groupKey, {
        category,
        projectScope: candidate.project_scope,
        candidates: [candidate],
        items: [displayItem],
        totalEvidence: candidate.evidence_count,
        maxSpanDays: candidate.observation_span_days,
      });
    }
  }

  // Synthesize each group into a single pattern
  const synthesized: PatternCandidate[] = [];

  for (const [, group] of groups) {
    // Skip groups with only 1 candidate — not enough signal to aggregate
    // (still pass through as-is so they can accumulate for next run)
    if (group.candidates.length < 2) {
      passThrough.push(...group.candidates);
      continue;
    }

    const synthesizer = CATEGORY_SYNTHESIZERS[group.category];
    const { content, description, tags } = synthesizer(group);

    // Merge evidence from all candidates
    const allEvidence = group.candidates.flatMap(c => c.evidence_snapshot).slice(0, 20);

    // Use the highest confidence from the group
    const maxConfidence = Math.max(...group.candidates.map(c => c.confidence));

    synthesized.push({
      pattern_type: 'repeated_tool',
      description,
      evidence_count: group.totalEvidence,
      observation_span_days: group.maxSpanDays,
      project_scope: group.projectScope,
      confidence: maxConfidence,
      content,
      evidence_snapshot: allEvidence,
      synthesized_tags: tags,
    });
  }

  return [...passThrough, ...synthesized];
}
