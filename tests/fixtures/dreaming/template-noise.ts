/**
 * T31 template-noise builders — the exact content shapes auto-discovery emits
 * for the three template families the referent guard covers (mirrors
 * `src/discovery/heuristics.ts` detectSequences/detectRepeatedToolInput and
 * `src/discovery/synthesizer.ts` file_access). Shared by the unit fixtures and
 * the replay referent-guard scenario so the guard is proven against the REAL
 * template text, not a paraphrase of it.
 */

/** "Workflow sequence detected: A → B. …" — the 82/91 majority noise class. */
export function sequenceContent(bigram: string, sessions = 3, total = 5, coveragePct = 60): string {
  return `Workflow sequence detected: ${bigram}. Observed in ${sessions}/${total} sessions (${coveragePct}% coverage). This consistent ordering suggests a deliberate workflow step.`;
}

/** "When working in this project, the operator frequently uses <tool> with: <payload>". */
export function repeatedToolContent(tool: string, payload: string): string {
  return `When working in this project, the operator frequently uses ${tool} with: ${payload}`;
}

/** The synthesizer "Key reference files" list template (referent_list family). */
export function keyFilesContent(project: string, files: string[]): string {
  const list = files.map(f => `  - ${f}`).join('\n');
  return `Key reference files frequently accessed in ${project}:\n${list}\n\nThese files are consistently accessed across sessions, suggesting they are architectural touchpoints or orientation files.`;
}
