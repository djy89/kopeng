// Minimal ambient declaration for project-scope.mjs so strict tsc can type
// the import from src/cli/doctor.ts (Task 2.1). The hook itself stays plain
// JS — see the module's own header for why (pure fs, no child_process, runs
// on every tool call across Claude Code and Codex).

export interface ProjectScopeResult {
  scope: string;
  source: 'marker' | 'remote' | 'basename';
}

export interface ProjectScopeOptions {
  /**
   * A pre-read ancestor chain from `readMarkerChain(cwd)`. Pass it when the caller
   * also reads the `scopes` key off the same walk (the recall hook does) so the
   * chain is read once; omit it and deriveProjectScope walks for itself.
   */
  markers?: unknown[];
}

/** One full-depth walk over `.kopeng.json`, nearest first — every marker that parsed. */
export function readMarkerChain(startDir: string, options?: { maxDepth?: number }): unknown[];

export function deriveProjectScope(cwd: string, options?: ProjectScopeOptions): ProjectScopeResult;
