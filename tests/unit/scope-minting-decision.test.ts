import { describe, it, expect } from 'vitest';
import { decideMint, buildMintContext, UNROUTED_SCOPE, type ScopeRegistryRow } from '../../src/scopes/minting.js';

const row = (over: Partial<ScopeRegistryRow>): ScopeRegistryRow => ({
  scope: 'project:my-project', slug: 'project:my-project',
  claimant_raw: 'project:My Project', origin_cwd: 'C:/dev/My Project',
  status: 'provisional', reserved: false,
  first_seen: '2026-08-19 00:00:00', updated_at: '2026-08-19 00:00:00', ruled_at: null,
  ...over,
});
const ctx = (rows: ScopeRegistryRow[], primary: string | null = null) => buildMintContext(rows, primary);

describe('decideMint', () => {
  it('global always passes and never registers', () => {
    expect(decideMint('global', 'C:/anywhere', ctx([]))).toEqual({ kind: 'pass', scope: 'global' });
  });

  it('malformed reroutes to primary when set, else _unrouted (R-C, R-D)', () => {
    expect(decideMint('status:archived', null, ctx([], 'project:kopeng')))
      .toEqual({ kind: 'reroute', scope: 'project:kopeng', raw: 'status:archived', reason: 'malformed' });
    expect(decideMint('no-prefix', null, ctx([])))
      .toEqual({ kind: 'reroute', scope: UNROUTED_SCOPE, raw: 'no-prefix', reason: 'malformed' });
  });

  it('ephemeral shapes pass unregistered', () => {
    const d = decideMint('project:wf_ab12cd34-e5f-1', 'C:/tmp/wf', ctx([]));
    expect(d).toEqual({ kind: 'pass', scope: 'project:wf_ab12cd34-e5f-1' });
  });

  it('fresh mint slug-adopts and registers provisional (done-when install one)', () => {
    const d = decideMint('project:My Project', 'C:/dev/My Project', ctx([]));
    expect(d.kind).toBe('mint');
    if (d.kind !== 'mint') return;
    expect(d.scope).toBe('project:my-project');
    expect(d.register).toEqual({
      scope: 'project:my-project', slug: 'project:my-project',
      claimant_raw: 'project:My Project', origin_cwd: 'C:/dev/My Project', status: 'provisional',
    });
  });

  it('claimant_raw match resolves to canonical (incumbent keeps landing home)', () => {
    const d = decideMint('project:My Project', 'C:/dev/My Project', ctx([row({})]));
    expect(d).toEqual({ kind: 'resolve', scope: 'project:my-project' });
  });

  it('claimant match with a MOVED origin still resolves (claimant string is primary identity)', () => {
    const d = decideMint('project:My Project', 'D:/moved/My Project', ctx([row({})]));
    expect(d).toEqual({ kind: 'resolve', scope: 'project:my-project' });
  });

  it('done-when install two: raw byte-equal to canonical, different origin, different claimant → quarantine --q2', () => {
    const d = decideMint('project:my-project', 'C:/dev/my-project', ctx([row({})]));
    expect(d.kind).toBe('quarantine');
    if (d.kind !== 'quarantine') return;
    expect(d.scope).toBe('project:my-project--q2');
    expect(d.register.status).toBe('quarantined');
    expect(d.register.claimant_raw).toBe('project:my-project');
    expect(d.register.origin_cwd).toBe('C:/dev/my-project');
  });

  it('explicit API write naming the canonical (no origin) passes as deliberate', () => {
    expect(decideMint('project:my-project', null, ctx([row({})])))
      .toEqual({ kind: 'pass', scope: 'project:my-project' });
  });

  it('new cased variant colliding by slug quarantines with the NEXT suffix', () => {
    const q2 = row({ scope: 'project:my-project--q2', claimant_raw: 'project:my-project', origin_cwd: 'C:/dev/my-project', status: 'quarantined' });
    const d = decideMint('project:My-Project', 'C:/elsewhere/My-Project', ctx([row({}), q2]));
    expect(d.kind).toBe('quarantine');
    if (d.kind !== 'quarantine') return;
    expect(d.scope).toBe('project:my-project--q3'); // 2 rows share the slug → n = 3
  });

  it('a quarantined claimant re-resolves to its quarantine scope via claimant+origin', () => {
    const q2 = row({ scope: 'project:my-project--q2', claimant_raw: 'project:my-project', origin_cwd: 'C:/dev/my-project', status: 'quarantined' });
    const d = decideMint('project:my-project', 'C:/dev/my-project', ctx([row({}), q2]));
    expect(d).toEqual({ kind: 'resolve', scope: 'project:my-project--q2' });
  });

  it('reserved rows collide like any other: a dir named _unrouted cannot claim the reserved scope', () => {
    const reserved = row({ scope: UNROUTED_SCOPE, slug: 'project:unrouted', claimant_raw: UNROUTED_SCOPE, origin_cwd: null, status: 'confirmed', reserved: true });
    const d = decideMint('project:unrouted', 'C:/dev/unrouted', ctx([reserved]));
    expect(d.kind).toBe('quarantine');
  });

  it('two same-named claimants (identical raw, identical claimant) pass — pre-existing ambiguity, out of scope', () => {
    const selfNamed = row({ scope: 'project:tools-x', slug: 'project:tools-x', claimant_raw: 'project:tools-x', origin_cwd: 'C:/a/tools-x' });
    expect(decideMint('project:tools-x', 'C:/b/tools-x', ctx([selfNamed])))
      .toEqual({ kind: 'pass', scope: 'project:tools-x' });
  });
});
