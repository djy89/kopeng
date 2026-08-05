import { describe, it, expect } from 'vitest';
import { detectPatterns } from '../../src/discovery/heuristics.js';
import type { Observation } from '../../src/types/types.js';

function makeObs(overrides: Partial<Observation> = {}, id?: number): Observation {
  return {
    id: id ?? 1,
    idempotency_key: null,
    session_id: 'session-1',
    project_scope: 'project:test',
    tool_name: 'Bash',
    input_summary: 'npm test',
    output_summary: null,
    status: 'completed',
    started_at: '2026-04-01 10:00:00',
    completed_at: '2026-04-01 10:00:01',
    duration_ms: 1000,
    metadata: '{}',
    schema_version: 1,
    created_at: '2026-04-01 10:00:00',
    ...overrides,
  };
}

describe('detectPatterns', () => {
  const config = { minOccurrences: 3, minErrorOccurrences: 2 };

  describe('repeated tool+input', () => {
    it('should detect repeated tool+input at exactly minOccurrences', () => {
      const obs = [
        makeObs({ tool_name: 'Bash', input_summary: 'npm test' }, 1),
        makeObs({ tool_name: 'Bash', input_summary: 'npm test' }, 2),
        makeObs({ tool_name: 'Bash', input_summary: 'npm test' }, 3),
      ];

      const patterns = detectPatterns(obs, config);
      expect(patterns.length).toBeGreaterThanOrEqual(1);
      const repeated = patterns.find(p => p.pattern_type === 'repeated_tool');
      expect(repeated).toBeDefined();
      expect(repeated!.evidence_count).toBe(3);
    });

    it('should NOT detect at minOccurrences - 1 (boundary)', () => {
      const obs = [
        makeObs({ tool_name: 'Read', input_summary: 'file.ts' }, 1),
        makeObs({ tool_name: 'Read', input_summary: 'file.ts' }, 2),
      ];

      const patterns = detectPatterns(obs, config);
      const repeated = patterns.filter(p => p.pattern_type === 'repeated_tool');
      expect(repeated).toHaveLength(0);
    });

    it('should normalize whitespace in input comparison', () => {
      const obs = [
        makeObs({ input_summary: 'npm   test' }, 1),
        makeObs({ input_summary: 'npm test' }, 2),
        makeObs({ input_summary: '  npm test  ' }, 3),
      ];

      const patterns = detectPatterns(obs, config);
      const repeated = patterns.find(p => p.pattern_type === 'repeated_tool');
      expect(repeated).toBeDefined();
      expect(repeated!.evidence_count).toBe(3);
    });

    it('should be case insensitive', () => {
      const obs = [
        makeObs({ input_summary: 'NPM TEST' }, 1),
        makeObs({ input_summary: 'npm test' }, 2),
        makeObs({ input_summary: 'Npm Test' }, 3),
      ];

      const patterns = detectPatterns(obs, config);
      const repeated = patterns.find(p => p.pattern_type === 'repeated_tool');
      expect(repeated).toBeDefined();
    });

    it('should separate different tools with same input', () => {
      const obs = [
        makeObs({ tool_name: 'Bash', input_summary: 'test' }, 1),
        makeObs({ tool_name: 'Bash', input_summary: 'test' }, 2),
        makeObs({ tool_name: 'Read', input_summary: 'test' }, 3),
      ];

      const patterns = detectPatterns(obs, config);
      const repeated = patterns.filter(p => p.pattern_type === 'repeated_tool');
      expect(repeated).toHaveLength(0); // Neither tool has 3 occurrences
    });
  });

  describe('error-then-fix', () => {
    it('should detect error followed by successful retry', () => {
      const obs = [
        makeObs({ status: 'failed', input_summary: 'npm build', session_id: 's1' }, 1),
        makeObs({ status: 'completed', input_summary: 'npm build', session_id: 's1' }, 2),
        makeObs({ status: 'failed', input_summary: 'npm build', session_id: 's1' }, 3),
        makeObs({ status: 'completed', input_summary: 'npm build', session_id: 's1' }, 4),
        makeObs({ status: 'failed', input_summary: 'npm build', session_id: 's1' }, 5),
        makeObs({ status: 'completed', input_summary: 'npm build', session_id: 's1' }, 6),
      ];

      const patterns = detectPatterns(obs, config);
      const errorFix = patterns.find(p => p.pattern_type === 'error_fix');
      expect(errorFix).toBeDefined();
    });

    it('should not trigger for different sessions', () => {
      const obs = [
        makeObs({ status: 'failed', input_summary: 'cmd', session_id: 's1' }, 1),
        makeObs({ status: 'completed', input_summary: 'cmd', session_id: 's2' }, 2),
        makeObs({ status: 'failed', input_summary: 'cmd', session_id: 's3' }, 3),
        makeObs({ status: 'completed', input_summary: 'cmd', session_id: 's4' }, 4),
        makeObs({ status: 'failed', input_summary: 'cmd', session_id: 's5' }, 5),
        makeObs({ status: 'completed', input_summary: 'cmd', session_id: 's6' }, 6),
      ];

      const patterns = detectPatterns(obs, config);
      const errorFix = patterns.find(p => p.pattern_type === 'error_fix');
      expect(errorFix).toBeUndefined();
    });
  });

  describe('hot files', () => {
    it('should detect frequently modified files', () => {
      const obs = [
        makeObs({ tool_name: 'Edit', input_summary: 'Editing /src/config.ts at line 10' }, 1),
        makeObs({ tool_name: 'Edit', input_summary: 'Editing /src/config.ts at line 20' }, 2),
        makeObs({ tool_name: 'Write', input_summary: 'Writing /src/config.ts' }, 3),
      ];

      const patterns = detectPatterns(obs, config);
      const hotFile = patterns.find(p => p.pattern_type === 'hot_file');
      expect(hotFile).toBeDefined();
      expect(hotFile!.description).toContain('config.ts');
    });

    it('should not detect non-file tools', () => {
      const obs = [
        makeObs({ tool_name: 'Bash', input_summary: 'some-command' }, 1),
        makeObs({ tool_name: 'Bash', input_summary: 'some-command' }, 2),
        makeObs({ tool_name: 'Bash', input_summary: 'some-command' }, 3),
      ];

      const patterns = detectPatterns(obs, config);
      const hotFile = patterns.find(p => p.pattern_type === 'hot_file');
      expect(hotFile).toBeUndefined();
    });
  });

  describe('repeated commands', () => {
    it('should detect repeated bash commands', () => {
      const obs = [
        makeObs({ tool_name: 'Bash', input_summary: 'docker compose up -d' }, 1),
        makeObs({ tool_name: 'Bash', input_summary: 'docker compose up -d' }, 2),
        makeObs({ tool_name: 'Bash', input_summary: 'docker compose up -d' }, 3),
      ];

      const patterns = detectPatterns(obs, config);
      const workflow = patterns.find(p => p.pattern_type === 'workflow');
      expect(workflow).toBeDefined();
    });

    it('should normalize UUIDs and timestamps in commands', () => {
      const obs = [
        makeObs({ tool_name: 'Bash', input_summary: 'kubectl get pod abc12345-def6-7890-abcd-ef1234567890' }, 1),
        makeObs({ tool_name: 'Bash', input_summary: 'kubectl get pod 11111111-2222-3333-4444-555555555555' }, 2),
        makeObs({ tool_name: 'Bash', input_summary: 'kubectl get pod aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, 3),
      ];

      const patterns = detectPatterns(obs, config);
      const workflow = patterns.find(p => p.pattern_type === 'workflow');
      expect(workflow).toBeDefined();
      expect(workflow!.evidence_count).toBe(3);
    });
  });

  describe('evidence snapshots', () => {
    it('should include up to 10 evidence entries', () => {
      const obs = Array.from({ length: 15 }, (_, i) =>
        makeObs({ input_summary: 'npm test' }, i + 1)
      );

      const patterns = detectPatterns(obs, config);
      const repeated = patterns.find(p => p.pattern_type === 'repeated_tool');
      expect(repeated).toBeDefined();
      expect(repeated!.evidence_snapshot.length).toBeLessThanOrEqual(10);
    });

    it('should use hashed inputs, not raw data', () => {
      const obs = [
        makeObs({ input_summary: 'some-secret-command' }, 1),
        makeObs({ input_summary: 'some-secret-command' }, 2),
        makeObs({ input_summary: 'some-secret-command' }, 3),
      ];

      const patterns = detectPatterns(obs, config);
      const repeated = patterns.find(p => p.pattern_type === 'repeated_tool');
      expect(repeated).toBeDefined();
      for (const entry of repeated!.evidence_snapshot) {
        expect(entry.input_hash).not.toBe('some-secret-command');
        expect(entry.input_hash).toHaveLength(12); // sha256 truncated to 12 hex chars
      }
    });
  });

  describe('observation span', () => {
    it('should calculate correct span in days', () => {
      const obs = [
        makeObs({ input_summary: 'npm test', started_at: '2026-04-01 10:00:00' }, 1),
        makeObs({ input_summary: 'npm test', started_at: '2026-04-03 10:00:00' }, 2),
        makeObs({ input_summary: 'npm test', started_at: '2026-04-06 10:00:00' }, 3),
      ];

      const patterns = detectPatterns(obs, config);
      const repeated = patterns.find(p => p.pattern_type === 'repeated_tool');
      expect(repeated).toBeDefined();
      expect(repeated!.observation_span_days).toBe(5);
    });
  });

  describe('recurring errors', () => {
    it('should detect recurring errors grouped by signature', () => {
      const obs = [
        makeObs({
          status: 'failed',
          tool_name: 'Bash',
          input_summary: 'npm run build',
          output_summary: 'error TS2345: Argument of type...',
          metadata: JSON.stringify({ error_category: 'typescript', error_signature: 'ts2345' }),
          session_id: 's1',
        }, 1),
        makeObs({
          status: 'failed',
          tool_name: 'Bash',
          input_summary: 'npm run build',
          output_summary: 'error TS2345: Argument of type...',
          metadata: JSON.stringify({ error_category: 'typescript', error_signature: 'ts2345' }),
          session_id: 's2',
        }, 2),
      ];

      const patterns = detectPatterns(obs, config);
      const recurring = patterns.find(p => p.pattern_type === 'recurring_error');
      expect(recurring).toBeDefined();
      expect(recurring!.evidence_count).toBe(2);
      expect(recurring!.content).toContain('typescript');
      expect(recurring!.content).toContain('ts2345');
      expect(recurring!.distinct_sessions).toBe(2);
    });

    it('should NOT detect recurring errors below minErrorOccurrences', () => {
      const obs = [
        makeObs({
          status: 'failed',
          metadata: JSON.stringify({ error_category: 'runtime', error_signature: 'typeerror_foo' }),
        }, 1),
      ];

      const patterns = detectPatterns(obs, config);
      const recurring = patterns.find(p => p.pattern_type === 'recurring_error');
      expect(recurring).toBeUndefined();
    });

    it('should detect fix in same session', () => {
      const obs = [
        makeObs({
          status: 'failed',
          tool_name: 'Bash',
          input_summary: 'npm run build',
          output_summary: 'error TS2345',
          metadata: JSON.stringify({ error_category: 'typescript', error_signature: 'ts2345' }),
          session_id: 's1',
          started_at: '2026-04-01 10:00:00',
        }, 1),
        makeObs({
          status: 'completed',
          tool_name: 'Bash',
          input_summary: 'npm run build',
          output_summary: 'Build succeeded',
          session_id: 's1',
          started_at: '2026-04-01 10:05:00',
        }, 2),
        makeObs({
          status: 'failed',
          tool_name: 'Bash',
          input_summary: 'npm run build',
          output_summary: 'error TS2345',
          metadata: JSON.stringify({ error_category: 'typescript', error_signature: 'ts2345' }),
          session_id: 's2',
          started_at: '2026-04-02 10:00:00',
        }, 3),
      ];

      const patterns = detectPatterns(obs, config);
      const recurring = patterns.find(p => p.pattern_type === 'recurring_error');
      expect(recurring).toBeDefined();
      expect(recurring!.has_fix).toBe(true);
      expect(recurring!.content).toContain('Fix observed');
    });

    it('should track cross-project errors', () => {
      const obs = [
        makeObs({
          status: 'failed',
          project_scope: 'project:alpha',
          metadata: JSON.stringify({ error_category: 'command', error_signature: 'enoent' }),
        }, 1),
        makeObs({
          status: 'failed',
          project_scope: 'project:beta',
          metadata: JSON.stringify({ error_category: 'command', error_signature: 'enoent' }),
        }, 2),
      ];

      const patterns = detectPatterns(obs, config);
      const recurring = patterns.find(p => p.pattern_type === 'recurring_error');
      expect(recurring).toBeDefined();
      expect(recurring!.content).toContain('2 projects');
    });

    it('should include error evidence with category and signature', () => {
      const obs = [
        makeObs({
          status: 'failed',
          metadata: JSON.stringify({ error_category: 'build', error_signature: 'build_tsc' }),
          session_id: 's1',
        }, 1),
        makeObs({
          status: 'failed',
          metadata: JSON.stringify({ error_category: 'build', error_signature: 'build_tsc' }),
          session_id: 's2',
        }, 2),
      ];

      const patterns = detectPatterns(obs, config);
      const recurring = patterns.find(p => p.pattern_type === 'recurring_error');
      expect(recurring).toBeDefined();
      expect(recurring!.evidence_snapshot[0].error_category).toBe('build');
      expect(recurring!.evidence_snapshot[0].error_signature).toBe('build_tsc');
    });

    it('should ignore failed observations without error metadata', () => {
      const obs = [
        makeObs({ status: 'failed', metadata: '{}' }, 1),
        makeObs({ status: 'failed', metadata: '{}' }, 2),
        makeObs({ status: 'failed', metadata: '{}' }, 3),
      ];

      const patterns = detectPatterns(obs, config);
      const recurring = patterns.find(p => p.pattern_type === 'recurring_error');
      expect(recurring).toBeUndefined();
    });
  });

  describe('sequence detection', () => {
    it('should detect A→B sequences recurring across 2+ sessions', () => {
      const obs = [
        // Session 1: Read config → Edit config
        makeObs({ session_id: 's1', tool_name: 'Read', input_summary: '{"file_path":"c:\\\\app\\\\config.ts"}', started_at: '2026-04-01 10:00:00' }, 1),
        makeObs({ session_id: 's1', tool_name: 'Edit', input_summary: '{"file_path":"c:\\\\app\\\\config.ts"}', started_at: '2026-04-01 10:00:30' }, 2),
        // Session 2: Read config → Edit config (same pattern)
        makeObs({ session_id: 's2', tool_name: 'Read', input_summary: '{"file_path":"c:\\\\app\\\\config.ts"}', started_at: '2026-04-02 10:00:00' }, 3),
        makeObs({ session_id: 's2', tool_name: 'Edit', input_summary: '{"file_path":"c:\\\\app\\\\config.ts"}', started_at: '2026-04-02 10:00:30' }, 4),
      ];

      const patterns = detectPatterns(obs, config);
      const seq = patterns.find(p => p.pattern_type === 'sequence');
      expect(seq).toBeDefined();
      expect(seq!.content).toContain('Read(config.ts)');
      expect(seq!.content).toContain('Edit(config.ts)');
      expect(seq!.content).toContain('2/2 sessions');
      expect(seq!.distinct_sessions).toBe(2);
    });

    it('should NOT detect sequences that only appear in 1 session', () => {
      const obs = [
        makeObs({ session_id: 's1', tool_name: 'Read', input_summary: '{"file_path":"c:\\\\app\\\\unique.ts"}', started_at: '2026-04-01 10:00:00' }, 1),
        makeObs({ session_id: 's1', tool_name: 'Edit', input_summary: '{"file_path":"c:\\\\app\\\\unique.ts"}', started_at: '2026-04-01 10:00:30' }, 2),
        // Session 2 has a different pattern
        makeObs({ session_id: 's2', tool_name: 'Bash', input_summary: '{"command":"npm test"}', started_at: '2026-04-02 10:00:00' }, 3),
        makeObs({ session_id: 's2', tool_name: 'Bash', input_summary: '{"command":"git status"}', started_at: '2026-04-02 10:00:30' }, 4),
      ];

      const patterns = detectPatterns(obs, config);
      const seqs = patterns.filter(p => p.pattern_type === 'sequence');
      // Read(unique.ts)→Edit(unique.ts) only in s1, Bash(npm)→Bash(git) only in s2
      const readEdit = seqs.find(s => s.content.includes('unique.ts'));
      expect(readEdit).toBeUndefined();
    });

    it('should use file basename for sequence keys', () => {
      const obs = [
        // Session 1: different full paths, same basenames
        makeObs({ session_id: 's1', tool_name: 'Read', input_summary: '{"file_path":"c:\\\\project-a\\\\src\\\\routes.ts"}', started_at: '2026-04-01 10:00:00' }, 1),
        makeObs({ session_id: 's1', tool_name: 'Edit', input_summary: '{"file_path":"c:\\\\project-a\\\\src\\\\routes.ts"}', started_at: '2026-04-01 10:00:30' }, 2),
        // Session 2: same basenames, slightly different paths
        makeObs({ session_id: 's2', tool_name: 'Read', input_summary: '{"file_path":"c:\\\\project-a\\\\routes.ts"}', started_at: '2026-04-02 10:00:00' }, 3),
        makeObs({ session_id: 's2', tool_name: 'Edit', input_summary: '{"file_path":"c:\\\\project-a\\\\routes.ts"}', started_at: '2026-04-02 10:00:30' }, 4),
      ];

      const patterns = detectPatterns(obs, config);
      const seq = patterns.find(p => p.pattern_type === 'sequence');
      expect(seq).toBeDefined();
      expect(seq!.content).toContain('routes.ts');
    });

    it('should extract command name for Bash sequence keys', () => {
      const obs = [
        // Session 1: tsc → git
        makeObs({ session_id: 's1', tool_name: 'Bash', input_summary: '{"command":"npx tsc --noEmit --pretty"}', started_at: '2026-04-01 10:00:00' }, 1),
        makeObs({ session_id: 's1', tool_name: 'Bash', input_summary: '{"command":"git add -A && git commit"}', started_at: '2026-04-01 10:01:00' }, 2),
        // Session 2: tsc → git (same command pattern)
        makeObs({ session_id: 's2', tool_name: 'Bash', input_summary: '{"command":"npx tsc --noEmit"}', started_at: '2026-04-02 10:00:00' }, 3),
        makeObs({ session_id: 's2', tool_name: 'Bash', input_summary: '{"command":"git commit -m fix"}', started_at: '2026-04-02 10:01:00' }, 4),
      ];

      const patterns = detectPatterns(obs, config);
      const seq = patterns.find(p => p.pattern_type === 'sequence');
      expect(seq).toBeDefined();
      expect(seq!.content).toContain('Bash(npx)');
      expect(seq!.content).toContain('Bash(git)');
    });

    it('should skip self-loops (same key twice)', () => {
      const obs = [
        // Session 1: Read same file twice
        makeObs({ session_id: 's1', tool_name: 'Read', input_summary: '{"file_path":"c:\\\\app\\\\same.ts"}', started_at: '2026-04-01 10:00:00' }, 1),
        makeObs({ session_id: 's1', tool_name: 'Read', input_summary: '{"file_path":"c:\\\\app\\\\same.ts"}', started_at: '2026-04-01 10:00:30' }, 2),
        // Session 2: Read same file twice
        makeObs({ session_id: 's2', tool_name: 'Read', input_summary: '{"file_path":"c:\\\\app\\\\same.ts"}', started_at: '2026-04-02 10:00:00' }, 3),
        makeObs({ session_id: 's2', tool_name: 'Read', input_summary: '{"file_path":"c:\\\\app\\\\same.ts"}', started_at: '2026-04-02 10:00:30' }, 4),
      ];

      const patterns = detectPatterns(obs, config);
      const seqs = patterns.filter(p => p.pattern_type === 'sequence');
      // Read(same.ts) → Read(same.ts) should be skipped
      const selfLoop = seqs.find(s => s.content.includes('Read(same.ts) → Read(same.ts)'));
      expect(selfLoop).toBeUndefined();
    });

    it('should limit output to top 10 patterns', () => {
      // Generate many distinct sequences across 2 sessions
      const obs: Observation[] = [];
      let id = 1;
      for (const sessionId of ['s1', 's2']) {
        for (let i = 0; i < 20; i++) {
          obs.push(makeObs({
            session_id: sessionId,
            tool_name: 'Read',
            input_summary: `{"file_path":"c:\\\\app\\\\file${i}.ts"}`,
            started_at: `2026-04-01 10:${String(i).padStart(2, '0')}:00`,
          }, id++));
        }
      }

      const patterns = detectPatterns(obs, config);
      const seqs = patterns.filter(p => p.pattern_type === 'sequence');
      expect(seqs.length).toBeLessThanOrEqual(10);
    });

    it('should only count sequences within proximity window', () => {
      const obs = [
        // Session 1: A at position 0, B at position 6 (outside window of 4)
        makeObs({ session_id: 's1', tool_name: 'Read', input_summary: '{"file_path":"c:\\\\app\\\\a.ts"}', started_at: '2026-04-01 10:00:00' }, 1),
        makeObs({ session_id: 's1', tool_name: 'Bash', input_summary: '{"command":"echo 1"}', started_at: '2026-04-01 10:01:00' }, 2),
        makeObs({ session_id: 's1', tool_name: 'Bash', input_summary: '{"command":"echo 2"}', started_at: '2026-04-01 10:02:00' }, 3),
        makeObs({ session_id: 's1', tool_name: 'Bash', input_summary: '{"command":"echo 3"}', started_at: '2026-04-01 10:03:00' }, 4),
        makeObs({ session_id: 's1', tool_name: 'Bash', input_summary: '{"command":"echo 4"}', started_at: '2026-04-01 10:04:00' }, 5),
        makeObs({ session_id: 's1', tool_name: 'Edit', input_summary: '{"file_path":"c:\\\\app\\\\b.ts"}', started_at: '2026-04-01 10:05:00' }, 6),
        // Session 2: same distant pair
        makeObs({ session_id: 's2', tool_name: 'Read', input_summary: '{"file_path":"c:\\\\app\\\\a.ts"}', started_at: '2026-04-02 10:00:00' }, 7),
        makeObs({ session_id: 's2', tool_name: 'Bash', input_summary: '{"command":"echo 1"}', started_at: '2026-04-02 10:01:00' }, 8),
        makeObs({ session_id: 's2', tool_name: 'Bash', input_summary: '{"command":"echo 2"}', started_at: '2026-04-02 10:02:00' }, 9),
        makeObs({ session_id: 's2', tool_name: 'Bash', input_summary: '{"command":"echo 3"}', started_at: '2026-04-02 10:03:00' }, 10),
        makeObs({ session_id: 's2', tool_name: 'Bash', input_summary: '{"command":"echo 4"}', started_at: '2026-04-02 10:04:00' }, 11),
        makeObs({ session_id: 's2', tool_name: 'Edit', input_summary: '{"file_path":"c:\\\\app\\\\b.ts"}', started_at: '2026-04-02 10:05:00' }, 12),
      ];

      const patterns = detectPatterns(obs, config);
      const seqs = patterns.filter(p => p.pattern_type === 'sequence');
      // Read(a.ts) → Edit(b.ts) should NOT be found — too far apart (5 steps, window is 4)
      const distant = seqs.find(s => s.content.includes('Read(a.ts)') && s.content.includes('Edit(b.ts)'));
      expect(distant).toBeUndefined();
    });
  });
});
