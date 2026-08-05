import { describe, it, expect } from 'vitest';
import { synthesizePatterns } from '../../src/discovery/synthesizer.js';
import type { PatternCandidate } from '../../src/types/types.js';

function makeCandidate(overrides: Partial<PatternCandidate> & { tool?: string }): PatternCandidate {
  const tool = overrides.tool ?? 'Read';
  return {
    pattern_type: 'repeated_tool',
    description: `${tool} frequently called`,
    evidence_count: 3,
    observation_span_days: 2,
    project_scope: 'project:test-app',
    confidence: 0.5,
    content: overrides.content ?? `When working in this project, the operator frequently uses ${tool} with: {"file_path":"c:\\users\\test\\file.ts"}`,
    evidence_snapshot: [{
      tool,
      input_hash: 'abc123',
      session_id: 'session-1',
      at: '2026-04-15T10:00:00Z',
    }],
    ...overrides,
  };
}

describe('synthesizePatterns', () => {
  it('should pass through non-repeated_tool patterns unchanged', () => {
    const errorFix: PatternCandidate = makeCandidate({
      pattern_type: 'error_fix',
      content: 'When Bash fails, retrying succeeds',
    });
    const recurringError: PatternCandidate = makeCandidate({
      pattern_type: 'recurring_error',
      content: 'Recurring TS error: TS2345',
    });

    const result = synthesizePatterns([errorFix, recurringError]);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('When Bash fails, retrying succeeds');
    expect(result[1].content).toBe('Recurring TS error: TS2345');
  });

  it('should aggregate multiple file_access patterns into one insight', () => {
    const candidates = [
      makeCandidate({
        tool: 'Read',
        content: 'When working in this project, the operator frequently uses Read with: {"file_path":"c:\\users\\test\\app\\src\\api.ts"}',
      }),
      makeCandidate({
        tool: 'Read',
        content: 'When working in this project, the operator frequently uses Read with: {"file_path":"c:\\users\\test\\app\\src\\config.ts"}',
      }),
      makeCandidate({
        tool: 'Grep',
        content: 'When working in this project, the operator frequently uses Grep with: {"pattern":"handleRequest","path":"c:\\users\\test\\app\\src"}',
      }),
    ];

    const result = synthesizePatterns(candidates);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('Key reference files');
    expect(result[0].content).toContain('architectural touchpoints');
    expect(result[0].description).toContain('Key reference files');
  });

  it('should separate shell commands into infra vs build categories', () => {
    const candidates = [
      makeCandidate({
        tool: 'Bash',
        content: 'When working in this project, the operator frequently uses Bash with: {"command":"aws amplify get-job --app-id abc"}',
        evidence_snapshot: [{ tool: 'Bash', input_hash: 'a', session_id: 's1', at: '2026-04-15T10:00:00Z' }],
      }),
      makeCandidate({
        tool: 'Bash',
        content: 'When working in this project, the operator frequently uses Bash with: {"command":"aws ssm get-command-invocation --command-id xyz"}',
        evidence_snapshot: [{ tool: 'Bash', input_hash: 'b', session_id: 's1', at: '2026-04-15T10:00:00Z' }],
      }),
      makeCandidate({
        tool: 'Bash',
        content: 'When working in this project, the operator frequently uses Bash with: {"command":"npx tsc --noEmit --pretty"}',
        evidence_snapshot: [{ tool: 'Bash', input_hash: 'c', session_id: 's1', at: '2026-04-15T10:00:00Z' }],
      }),
      makeCandidate({
        tool: 'Bash',
        content: 'When working in this project, the operator frequently uses Bash with: {"command":"npm test -- --reporter=verbose"}',
        evidence_snapshot: [{ tool: 'Bash', input_hash: 'd', session_id: 's1', at: '2026-04-15T10:00:00Z' }],
      }),
    ];

    const result = synthesizePatterns(candidates);
    // Should produce 2 groups: shell_infra (aws commands) and shell_build (npm/tsc)
    expect(result).toHaveLength(2);

    const infra = result.find(r => r.content.includes('Infrastructure'));
    const build = result.find(r => r.content.includes('Build/test'));
    expect(infra).toBeDefined();
    expect(build).toBeDefined();
    expect(infra!.content).toContain('automation');
    expect(build!.content).toContain('quality gates');
  });

  it('should pass through single-candidate groups unchanged', () => {
    const single = makeCandidate({
      tool: 'Read',
      content: 'When working in this project, the operator frequently uses Read with: {"file_path":"c:\\users\\test\\solo.ts"}',
    });

    const result = synthesizePatterns([single]);
    expect(result).toHaveLength(1);
    // Should be the original candidate, not synthesized
    expect(result[0].content).toBe(single.content);
  });

  it('should group by project scope independently', () => {
    const candidates = [
      makeCandidate({
        tool: 'Read',
        project_scope: 'project:app-a',
        content: 'When working in this project, the operator frequently uses Read with: {"file_path":"c:\\apps\\a\\file1.ts"}',
      }),
      makeCandidate({
        tool: 'Read',
        project_scope: 'project:app-a',
        content: 'When working in this project, the operator frequently uses Read with: {"file_path":"c:\\apps\\a\\file2.ts"}',
      }),
      makeCandidate({
        tool: 'Read',
        project_scope: 'project:app-b',
        content: 'When working in this project, the operator frequently uses Read with: {"file_path":"c:\\apps\\b\\file1.ts"}',
      }),
      makeCandidate({
        tool: 'Read',
        project_scope: 'project:app-b',
        content: 'When working in this project, the operator frequently uses Read with: {"file_path":"c:\\apps\\b\\file2.ts"}',
      }),
    ];

    const result = synthesizePatterns(candidates);
    expect(result).toHaveLength(2);
    expect(result.find(r => r.project_scope === 'project:app-a')).toBeDefined();
    expect(result.find(r => r.project_scope === 'project:app-b')).toBeDefined();
  });

  it('should synthesize browser patterns with E2E test recommendation', () => {
    const candidates = [
      makeCandidate({
        tool: 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot',
        content: 'When working in this project, the operator frequently uses mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot with: {}',
        evidence_snapshot: [{ tool: 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot', input_hash: 'a', session_id: 's1', at: '2026-04-15T10:00:00Z' }],
      }),
      makeCandidate({
        tool: 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__click',
        content: 'When working in this project, the operator frequently uses mcp__plugin_chrome-devtools-mcp_chrome-devtools__click with: {"uid":"2_7"}',
        evidence_snapshot: [{ tool: 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__click', input_hash: 'b', session_id: 's1', at: '2026-04-15T10:00:00Z' }],
      }),
    ];

    const result = synthesizePatterns(candidates);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('Manual browser testing');
    expect(result[0].content).toContain('E2E test');
  });

  it('should handle mixed pattern types correctly', () => {
    const candidates = [
      // 2 file_access (will be synthesized)
      makeCandidate({
        tool: 'Read',
        content: 'When working in this project, the operator frequently uses Read with: {"file_path":"c:\\app\\src\\a.ts"}',
      }),
      makeCandidate({
        tool: 'Read',
        content: 'When working in this project, the operator frequently uses Read with: {"file_path":"c:\\app\\src\\b.ts"}',
      }),
      // 1 error_fix (pass through)
      makeCandidate({
        pattern_type: 'error_fix',
        content: 'Error then fix pattern',
      }),
      // 1 hot_file (pass through)
      makeCandidate({
        pattern_type: 'hot_file',
        content: 'Hot file detected',
      }),
    ];

    const result = synthesizePatterns(candidates);
    expect(result).toHaveLength(3); // 1 synthesized + 2 pass-through
    expect(result.find(r => r.content.includes('Key reference files'))).toBeDefined();
    expect(result.find(r => r.content === 'Error then fix pattern')).toBeDefined();
    expect(result.find(r => r.content === 'Hot file detected')).toBeDefined();
  });
});
