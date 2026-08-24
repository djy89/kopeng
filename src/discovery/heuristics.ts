/**
 * Inline heuristic detectors for pattern discovery.
 * Six zero-cost detectors (no API calls):
 * 1. Repeated tool+input — same (tool_name, normalized_input) N+ times
 * 2. Error-then-fix — failed completion followed by successful retry
 * 3. Hot files — same file in Write/Edit input 3+ times in a session
 * 4. Repeated commands — normalized Bash commands recurring
 * 5. Recurring errors — same error signature across sessions
 * 6. Sequences — tool A consistently followed by tool B across sessions
 */

import crypto from 'crypto';
import type { Observation, PatternCandidate, EvidenceEntry, DiscoveryConfig } from '../types/types.js';

/**
 * Normalize input for comparison: lowercase, collapse whitespace, trim.
 */
function normalizeInput(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Generate a short hash for evidence snapshots (not raw data).
 */
function hashInput(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/**
 * Extract file paths from tool input summaries.
 * Handles common patterns: absolute paths, relative paths, quoted paths.
 */
/**
 * Reject obvious non-file matches that look path-like in source code
 * (comment markers, regex literals, URL fragments without paths).
 */
function isLikelyFilePath(p: string): boolean {
  if (!p) return false;
  // Comment markers — JSDoc opener, line comment, block comment
  if (/^\/{2,}/.test(p)) return false;
  if (/^\/\*/.test(p)) return false;
  // Just a path separator with nothing else
  if (p === '/' || p === '\\') return false;
  // Pure regex-like junk (e.g. `/^foo/`)
  if (/^\/[\^$].*\/[gimsuy]*$/.test(p)) return false;
  return true;
}

function extractFilePaths(input: string): string[] {
  // Tool inputs are JSON-stringified by the hook. The `file_path` field is
  // always near the start of the object, before large `content`/`old_string`
  // /`new_string` payloads that get truncated at 5000 chars. Targeted regex
  // for the file-path keys works even when the rest of the JSON is truncated;
  // unrestricted regex picks up code content (`/**`, `//`) as false positives.
  const FIELD_KEYS = ['file_path', 'path', 'notebook_path'];
  const paths: string[] = [];
  for (const key of FIELD_KEYS) {
    // Match `"key":"<value>"` where value can contain escaped chars.
    const m = input.match(new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
    if (m) {
      try {
        const parsed = JSON.parse(m[1]);
        if (typeof parsed === 'string' && parsed) paths.push(parsed);
      } catch {
        /* malformed escape, skip */
      }
    }
  }
  if (paths.length > 0) return paths.filter(isLikelyFilePath);

  // Last-resort fallback (no recognized key found — legacy hook format).
  const patterns = [
    /(?:^|\s|["'])((?:\/|[A-Za-z]:\\|\.\.?\/)[^\s"']+)/g,
    /["']([^"']+\.[a-zA-Z]{1,10})["']/g,
  ];
  const fallback = new Set<string>();
  for (const pattern of patterns) {
    for (const match of input.matchAll(pattern)) {
      if (match[1] && isLikelyFilePath(match[1])) fallback.add(match[1]);
    }
  }
  return [...fallback];
}

/**
 * Normalize a bash command for comparison.
 * Strips variable parts: paths with unique segments, UUIDs, timestamps.
 */
function normalizeCommand(cmd: string): string {
  return cmd
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, '<TIMESTAMP>')
    .replace(/\d{10,}/g, '<NUM>')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function buildEvidence(obs: Observation, input: string): EvidenceEntry {
  return {
    tool: obs.tool_name,
    input_hash: hashInput(input),
    session_id: obs.session_id,
    at: obs.started_at,
  };
}

/**
 * Tools that are purely meta/self-referential — detecting patterns in these
 * creates circular noise (e.g., memory tools creating memories about memory usage).
 */
const REPEATED_TOOL_IGNORE = new Set([
  'ToolSearch',                            // meta-tool schema lookups
]);

/**
 * Input patterns that indicate ephemeral, non-repeatable invocations.
 * These contain session-specific IDs or temp paths that won't recur.
 */
const EPHEMERAL_INPUT_PATTERNS = [
  /\\temp\\/i,                              // temp file paths
  /\\appdata\\local\\temp\\/i,              // Windows temp
  /\/tmp\//i,                               // Unix temp
  /tasks[/\\][a-z0-9]+\.output/i,           // Claude task output files
  /\.claude[/\\]plans\\/i,                  // ephemeral plan files
];

function isEphemeralInput(input: string): boolean {
  return EPHEMERAL_INPUT_PATTERNS.some(p => p.test(input));
}

/**
 * Detect repeated tool+input patterns.
 * Same (tool_name, normalized_input) occurring minOccurrences+ times.
 * Skips self-referential tools and ephemeral inputs.
 */
function detectRepeatedToolInput(
  observations: Observation[],
  minOccurrences: number
): PatternCandidate[] {
  const counts = new Map<string, { obs: Observation[]; normalized: string }>();

  for (const obs of observations) {
    if (!obs.input_summary) continue;
    if (REPEATED_TOOL_IGNORE.has(obs.tool_name)) continue;
    if (obs.tool_name.startsWith('mcp__kopeng__') || obs.tool_name.startsWith('mcp__memory__')) continue;
    if (isEphemeralInput(obs.input_summary)) continue;

    const normalized = normalizeInput(obs.input_summary);
    const key = `${obs.tool_name}::${normalized}`;

    const existing = counts.get(key);
    if (existing) {
      existing.obs.push(obs);
    } else {
      counts.set(key, { obs: [obs], normalized });
    }
  }

  const patterns: PatternCandidate[] = [];
  for (const [, { obs, normalized }] of counts) {
    if (obs.length < minOccurrences) continue;

    const firstAt = new Date(obs[0].started_at).getTime();
    const lastAt = new Date(obs[obs.length - 1].started_at).getTime();
    const spanDays = (lastAt - firstAt) / (1000 * 60 * 60 * 24);

    patterns.push({
      pattern_type: 'repeated_tool',
      description: `${obs[0].tool_name} frequently called with similar input: "${normalized.slice(0, 100)}"`,
      evidence_count: obs.length,
      observation_span_days: Math.round(spanDays * 100) / 100,
      project_scope: obs[0].project_scope,
      confidence: 0, // computed by caller
      content: `When working in this project, the operator frequently uses ${obs[0].tool_name} with: ${normalized.slice(0, 200)}`,
      evidence_snapshot: obs.slice(0, 10).map(o => buildEvidence(o, o.input_summary!)),
    });
  }

  return patterns;
}

/**
 * Detect error-then-fix patterns.
 * A failed completion followed by a successful retry with similar input.
 */
function detectErrorFix(
  observations: Observation[],
  minOccurrences: number
): PatternCandidate[] {
  const fixes: { failed: Observation; succeeded: Observation }[] = [];

  for (let i = 0; i < observations.length - 1; i++) {
    const current = observations[i];
    if (current.status !== 'failed') continue;

    // Look for a successful follow-up within the next 5 observations
    for (let j = i + 1; j < Math.min(i + 6, observations.length); j++) {
      const next = observations[j];
      if (next.status !== 'completed') continue;
      if (next.tool_name !== current.tool_name) continue;
      if (next.session_id !== current.session_id) continue;

      // Check input similarity (same tool, similar input = retry)
      if (current.input_summary && next.input_summary) {
        const normCurrent = normalizeInput(current.input_summary);
        const normNext = normalizeInput(next.input_summary);
        // Simple prefix match as similarity proxy
        const shorter = Math.min(normCurrent.length, normNext.length);
        if (shorter > 0) {
          const commonPrefix = normCurrent.slice(0, shorter) === normNext.slice(0, shorter);
          if (commonPrefix || normCurrent.includes(normNext) || normNext.includes(normCurrent)) {
            fixes.push({ failed: current, succeeded: next });
            break;
          }
        }
      }
    }
  }

  if (fixes.length < minOccurrences) return [];

  // Group fixes by tool+normalized input for pattern consolidation
  const grouped = new Map<string, typeof fixes>();
  for (const fix of fixes) {
    const key = `${fix.failed.tool_name}::${normalizeInput(fix.failed.input_summary ?? '')}`;
    const existing = grouped.get(key) ?? [];
    existing.push(fix);
    grouped.set(key, existing);
  }

  const patterns: PatternCandidate[] = [];
  for (const [, group] of grouped) {
    if (group.length < minOccurrences) continue;

    const allObs = group.flatMap(g => [g.failed, g.succeeded]);
    const firstAt = new Date(allObs[0].started_at).getTime();
    const lastAt = new Date(allObs[allObs.length - 1].started_at).getTime();
    const spanDays = (lastAt - firstAt) / (1000 * 60 * 60 * 24);

    const tool = group[0].failed.tool_name;
    const input = normalizeInput(group[0].failed.input_summary ?? '');

    // Extract error metadata for richer content
    const failedMeta = parseErrorMeta(group[0].failed);
    const errorInfo = failedMeta.category ? ` [${failedMeta.category}: ${failedMeta.signature || 'unknown'}]` : '';
    const failedOutput = (group[0].failed.output_summary || '').slice(0, 200);
    const fixOutput = (group[0].succeeded.output_summary || '').slice(0, 200);

    let content = `When ${tool} fails${errorInfo} with "${input.slice(0, 120)}", retrying typically succeeds. Observed ${group.length} times.`;
    if (failedOutput) content += `\nError output: ${failedOutput}`;
    if (fixOutput) content += `\nFix output: ${fixOutput}`;

    patterns.push({
      pattern_type: 'error_fix',
      description: `${tool} commonly fails${errorInfo} then succeeds on retry with input: "${input.slice(0, 80)}"`,
      evidence_count: group.length,
      observation_span_days: Math.round(spanDays * 100) / 100,
      project_scope: group[0].failed.project_scope,
      confidence: 0,
      content,
      evidence_snapshot: allObs.slice(0, 10).map(o => {
        const meta = parseErrorMeta(o);
        return {
          ...buildEvidence(o, o.input_summary ?? ''),
          error_category: meta.category,
          error_signature: meta.signature,
        };
      }),
    });
  }

  return patterns;
}

/**
 * Detect hot files — same file path appearing in Write/Edit/Read inputs 3+ times per session.
 */
function detectHotFiles(
  observations: Observation[],
  minOccurrences: number
): PatternCandidate[] {
  const FILE_TOOLS = new Set(['Write', 'Edit', 'Read', 'write_file', 'edit_file', 'read_file']);

  // Group by session, then count file occurrences
  const sessionFiles = new Map<string, Map<string, Observation[]>>();

  for (const obs of observations) {
    if (!FILE_TOOLS.has(obs.tool_name) || !obs.input_summary) continue;

    const paths = extractFilePaths(obs.input_summary);
    for (const filePath of paths) {
      const sessionKey = obs.session_id;
      if (!sessionFiles.has(sessionKey)) {
        sessionFiles.set(sessionKey, new Map());
      }
      const files = sessionFiles.get(sessionKey)!;
      const existing = files.get(filePath) ?? [];
      existing.push(obs);
      files.set(filePath, existing);
    }
  }

  // Aggregate across sessions: count how many sessions show the same hot file
  const crossSessionCounts = new Map<string, { sessions: number; totalObs: Observation[] }>();

  for (const [, files] of sessionFiles) {
    for (const [filePath, obs] of files) {
      if (obs.length < minOccurrences) continue;

      const existing = crossSessionCounts.get(filePath) ?? { sessions: 0, totalObs: [] };
      existing.sessions++;
      existing.totalObs.push(...obs);
      crossSessionCounts.set(filePath, existing);
    }
  }

  const patterns: PatternCandidate[] = [];
  for (const [filePath, { sessions, totalObs }] of crossSessionCounts) {
    if (sessions < 1) continue; // At least one session with hot file

    const firstAt = new Date(totalObs[0].started_at).getTime();
    const lastAt = new Date(totalObs[totalObs.length - 1].started_at).getTime();
    const spanDays = (lastAt - firstAt) / (1000 * 60 * 60 * 24);

    patterns.push({
      pattern_type: 'hot_file',
      description: `File "${filePath}" frequently modified (${totalObs.length} times across ${sessions} session(s))`,
      evidence_count: totalObs.length,
      observation_span_days: Math.round(spanDays * 100) / 100,
      project_scope: totalObs[0].project_scope,
      confidence: 0,
      content: `The file ${filePath} is a frequent edit target in this project, modified ${totalObs.length} times across ${sessions} session(s).`,
      evidence_snapshot: totalObs.slice(0, 10).map(o => buildEvidence(o, o.input_summary!)),
    });
  }

  return patterns;
}

/**
 * Detect repeated Bash commands (normalized).
 */
function detectRepeatedCommands(
  observations: Observation[],
  minOccurrences: number
): PatternCandidate[] {
  const BASH_TOOLS = new Set(['Bash', 'bash', 'shell', 'terminal']);

  const counts = new Map<string, Observation[]>();

  for (const obs of observations) {
    if (!BASH_TOOLS.has(obs.tool_name) || !obs.input_summary) continue;

    const normalized = normalizeCommand(obs.input_summary);
    const existing = counts.get(normalized) ?? [];
    existing.push(obs);
    counts.set(normalized, existing);
  }

  const patterns: PatternCandidate[] = [];
  for (const [normalized, obs] of counts) {
    if (obs.length < minOccurrences) continue;

    const firstAt = new Date(obs[0].started_at).getTime();
    const lastAt = new Date(obs[obs.length - 1].started_at).getTime();
    const spanDays = (lastAt - firstAt) / (1000 * 60 * 60 * 24);

    patterns.push({
      pattern_type: 'workflow',
      description: `Bash command frequently repeated: "${normalized.slice(0, 100)}"`,
      evidence_count: obs.length,
      observation_span_days: Math.round(spanDays * 100) / 100,
      project_scope: obs[0].project_scope,
      confidence: 0,
      content: `The operator frequently runs this command in the project: ${normalized.slice(0, 200)}`,
      evidence_snapshot: obs.slice(0, 10).map(o => buildEvidence(o, o.input_summary!)),
    });
  }

  return patterns;
}

/**
 * Parse error metadata from an observation's metadata JSON string.
 */
function parseErrorMeta(obs: Observation): { category?: string; signature?: string } {
  try {
    const meta = typeof obs.metadata === 'string' ? JSON.parse(obs.metadata) : obs.metadata;
    return {
      category: meta?.error_category as string | undefined,
      signature: meta?.error_signature as string | undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Detect recurring error patterns.
 * Groups failed observations by error_signature across sessions.
 * Lower threshold than other heuristics (errors are high-signal).
 * Also detects cross-project patterns when the same signature appears in 3+ projects.
 */
function detectRecurringErrors(
  observations: Observation[],
  minOccurrences: number
): PatternCandidate[] {
  // Only look at failed observations
  const failed = observations.filter(obs => obs.status === 'failed');
  if (failed.length === 0) return [];

  // Group by error_signature
  const groups = new Map<string, {
    obs: Observation[];
    category: string;
    sessions: Set<string>;
    projects: Set<string>;
  }>();

  for (const obs of failed) {
    const { category, signature } = parseErrorMeta(obs);
    if (!signature) continue;

    const existing = groups.get(signature);
    if (existing) {
      existing.obs.push(obs);
      existing.sessions.add(obs.session_id);
      existing.projects.add(obs.project_scope);
    } else {
      groups.set(signature, {
        obs: [obs],
        category: category || 'unknown',
        sessions: new Set([obs.session_id]),
        projects: new Set([obs.project_scope]),
      });
    }
  }

  const patterns: PatternCandidate[] = [];

  for (const [signature, group] of groups) {
    if (group.obs.length < minOccurrences) continue;

    const firstAt = new Date(group.obs[0].started_at).getTime();
    const lastAt = new Date(group.obs[group.obs.length - 1].started_at).getTime();
    const spanDays = (lastAt - firstAt) / (1000 * 60 * 60 * 24);

    // Check if a fix was observed: same session, same tool, completed after failure
    let hasFix = false;
    let fixSnippet = '';
    for (const failedObs of group.obs) {
      const fix = observations.find(o =>
        o.session_id === failedObs.session_id &&
        o.tool_name === failedObs.tool_name &&
        o.status === 'completed' &&
        new Date(o.started_at).getTime() > new Date(failedObs.started_at).getTime()
      );
      if (fix) {
        hasFix = true;
        fixSnippet = (fix.output_summary || '').slice(0, 200);
        break;
      }
    }

    // Build descriptive content with the most recent error output
    const recentError = group.obs[group.obs.length - 1];
    const errorSnippet = (recentError.output_summary || '').slice(0, 300);
    const crossProject = group.projects.size >= 2;

    let content = `Recurring ${group.category} error: ${signature}. Seen ${group.obs.length} times across ${group.sessions.size} session(s).`;
    if (crossProject) content += ` Appears in ${group.projects.size} projects.`;
    if (errorSnippet) content += `\nError: ${errorSnippet}`;
    if (hasFix && fixSnippet) content += `\nFix observed: ${fixSnippet}`;

    patterns.push({
      pattern_type: 'recurring_error',
      description: `Recurring ${group.category} error: ${signature} (${group.obs.length}x across ${group.sessions.size} session(s))`,
      evidence_count: group.obs.length,
      observation_span_days: Math.round(spanDays * 100) / 100,
      project_scope: recentError.project_scope,
      confidence: 0, // computed by caller
      content,
      evidence_snapshot: group.obs.slice(0, 10).map(o => {
        const meta = parseErrorMeta(o);
        return {
          ...buildEvidence(o, o.input_summary ?? ''),
          error_category: meta.category,
          error_signature: meta.signature,
        };
      }),
      has_fix: hasFix,
      distinct_sessions: group.sessions.size,
    });
  }

  return patterns;
}

/**
 * Build a compact sequence key from a tool observation.
 * Normalizes to a consistent granularity for cross-session comparison:
 * - File tools → Tool(basename)  e.g., Read(routes.ts)
 * - Bash → Bash(command_name)    e.g., Bash(tsc), Bash(git)
 * - MCP tools → last segment     e.g., get_issue, take_screenshot
 * - Other → tool name            e.g., Agent, Edit
 */
function getSequenceKey(toolName: string, inputSummary: string): string {
  // File tools: extract basename
  if (['Read', 'read_file', 'Write', 'write_file', 'Edit', 'edit_file'].includes(toolName)) {
    const pathMatch = inputSummary.match(/"file_path"\s*:\s*"([^"]+)"/i);
    if (pathMatch) {
      const basename = pathMatch[1].replace(/\\\\/g, '\\').split(/[/\\]/).pop() || toolName;
      return `${toolName}(${basename.toLowerCase()})`;
    }
    return toolName;
  }

  // Search tools: extract target
  if (toolName === 'Grep' || toolName === 'Glob') {
    const patternMatch = inputSummary.match(/"pattern"\s*:\s*"([^"]{1,30})"/i);
    if (patternMatch) return `${toolName}("${patternMatch[1]}")`;
    return toolName;
  }

  // Bash: extract command name (first word)
  if (['Bash', 'bash', 'shell', 'terminal'].includes(toolName)) {
    const cmdMatch = inputSummary.match(/"command"\s*:\s*"([^"]+)"/i);
    if (cmdMatch) {
      // Strip cd prefix, get the actual command
      let cmd = cmdMatch[1].trim();
      cmd = cmd.replace(/^cd\s+"[^"]+"\s*&&\s*/i, '');
      const firstWord = cmd.split(/\s+/)[0].replace(/.*[/\\]/, ''); // strip path prefix
      return `Bash(${firstWord.toLowerCase()})`;
    }
    return 'Bash';
  }

  // MCP tools: use the action name (last segment)
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return parts[parts.length - 1];
  }

  return toolName;
}

/**
 * Detect sequential patterns — tool A consistently followed by tool B across sessions.
 *
 * Algorithm:
 * 1. Group observations by session, sort by timestamp
 * 2. Extract sequence keys for each operation
 * 3. Find bigrams (A→B pairs) within a proximity window
 * 4. Count bigrams across sessions — recurring ones are workflow patterns
 *
 * Minimum 2 distinct sessions required for a sequence pattern.
 */
function detectSequences(
  observations: Observation[],
  minSessions: number
): PatternCandidate[] {
  // Group by session and sort by time
  const sessions = new Map<string, Observation[]>();
  for (const obs of observations) {
    if (obs.status === 'started') continue; // only look at completed/failed
    const existing = sessions.get(obs.session_id) ?? [];
    existing.push(obs);
    sessions.set(obs.session_id, existing);
  }

  // Need at least 2 sessions to detect cross-session patterns
  if (sessions.size < minSessions) return [];

  const WINDOW_SIZE = 4; // look at next N operations for bigrams

  // Count bigrams across sessions
  const bigrams = new Map<string, {
    sessions: Set<string>;
    totalOccurrences: number;
    examples: { a: Observation; b: Observation }[];
    projectScope: string;
    keyA: string;
    keyB: string;
  }>();

  for (const [sessionId, ops] of sessions) {
    // Sort by timestamp within session
    ops.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());

    // Extract sequence keys
    const keyed = ops.map(obs => ({
      key: getSequenceKey(obs.tool_name, obs.input_summary ?? ''),
      obs,
    }));

    // Find bigrams within window
    const seenInSession = new Set<string>(); // dedupe within session
    for (let i = 0; i < keyed.length; i++) {
      for (let j = i + 1; j < Math.min(i + 1 + WINDOW_SIZE, keyed.length); j++) {
        const a = keyed[i];
        const b = keyed[j];

        // Skip self-loops (same key twice)
        if (a.key === b.key) continue;

        const bigramKey = `${a.key} → ${b.key}`;
        if (seenInSession.has(bigramKey)) continue;
        seenInSession.add(bigramKey);

        const existing = bigrams.get(bigramKey);
        if (existing) {
          existing.sessions.add(sessionId);
          existing.totalOccurrences++;
          if (existing.examples.length < 5) {
            existing.examples.push({ a: a.obs, b: b.obs });
          }
        } else {
          bigrams.set(bigramKey, {
            sessions: new Set([sessionId]),
            totalOccurrences: 1,
            examples: [{ a: a.obs, b: b.obs }],
            projectScope: a.obs.project_scope,
            keyA: a.key,
            keyB: b.key,
          });
        }
      }
    }
  }

  // Emit patterns for bigrams that recur across enough sessions
  const patterns: PatternCandidate[] = [];

  for (const [bigramKey, data] of bigrams) {
    if (data.sessions.size < minSessions) continue;

    // Calculate session coverage ratio — how often does this sequence appear?
    const coverage = data.sessions.size / sessions.size;

    // Only emit if the sequence appears in a meaningful fraction of sessions
    // or appears in enough absolute sessions
    if (coverage < 0.3 && data.sessions.size < 3) continue;

    const firstExample = data.examples[0];
    const firstAt = new Date(firstExample.a.started_at).getTime();
    const lastExample = data.examples[data.examples.length - 1];
    const lastAt = new Date(lastExample.b.started_at).getTime();
    const spanDays = (lastAt - firstAt) / (1000 * 60 * 60 * 24);

    const coveragePct = Math.round(coverage * 100);

    patterns.push({
      pattern_type: 'sequence',
      description: `Workflow sequence: ${bigramKey} (${data.sessions.size} sessions, ${coveragePct}% coverage)`,
      evidence_count: data.totalOccurrences,
      observation_span_days: Math.round(Math.abs(spanDays) * 100) / 100,
      project_scope: data.projectScope,
      confidence: 0, // computed by caller
      content: `Workflow sequence detected: ${bigramKey}. Observed in ${data.sessions.size}/${sessions.size} sessions (${coveragePct}% coverage). This consistent ordering suggests a deliberate workflow step.`,
      evidence_snapshot: data.examples.slice(0, 5).flatMap(ex => [
        buildEvidence(ex.a, ex.a.input_summary ?? ''),
        buildEvidence(ex.b, ex.b.input_summary ?? ''),
      ]),
      distinct_sessions: data.sessions.size,
      steps: [data.keyA, data.keyB],
    });
  }

  // Sort by session count descending — most consistent patterns first
  patterns.sort((a, b) => (b.distinct_sessions ?? 0) - (a.distinct_sessions ?? 0));

  // Limit to top 10 most consistent sequences per batch to avoid flooding
  return patterns.slice(0, 10);
}

/**
 * Run all heuristic detectors on a batch of observations.
 * Returns pattern candidates with confidence = 0 (caller computes confidence).
 */
export function detectPatterns(
  observations: Observation[],
  config: Pick<DiscoveryConfig, 'minOccurrences' | 'minErrorOccurrences'>
): PatternCandidate[] {
  const minOcc = config.minOccurrences;
  const minErrorOcc = config.minErrorOccurrences ?? 2;

  return [
    ...detectRepeatedToolInput(observations, minOcc),
    ...detectErrorFix(observations, minOcc),
    ...detectHotFiles(observations, minOcc),
    ...detectRepeatedCommands(observations, minOcc),
    ...detectRecurringErrors(observations, minErrorOcc),
    ...detectSequences(observations, 2),
  ];
}
