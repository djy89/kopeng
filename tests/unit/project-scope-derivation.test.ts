/**
 * RULING-C (WS7.6): project scope derivation from the git remote.
 *
 * Precedence: `.kopeng.json` `project` override > git remote
 * (`project:<owner>-<repo>`) > `project:<basename(cwd)>` fallback — the
 * byte-identical pre-derivation behavior. Every fixture here is fabricated
 * with pure fs (no git binary anywhere in this suite — that IS the point:
 * T57 taught us installs can be gitless, so the derivation must never shell
 * out to `git`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { deriveProjectScope, readMarkerChain } from '../../scripts/hooks/project-scope.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(HERE, '../../scripts/hooks/project-scope.mjs');

const tmp = mkdtempSync(join(tmpdir(), 'kopeng-project-scope-'));
let counter = 0;
function freshDir(...parts: string[]): string {
  const dir = join(tmp, `t${counter++}`, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Fabricate `<root>/.git/config` with one `[remote "<name>"]` section. */
function makeRepo(root: string, remoteUrl: string, remoteName = 'origin'): void {
  const gitDir = join(root, '.git');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(
    join(gitDir, 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "${remoteName}"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/${remoteName}/*\n`
  );
}

/** Fabricate a linked worktree: `<worktreeRoot>/.git` FILE → gitdir under
 * `<mainRoot>/.git/worktrees/<name>` → commondir pointing back at `<mainRoot>/.git`,
 * which is where the real remote config lives (worktree gitdirs don't carry one). */
function makeWorktree(mainRoot: string, worktreeRoot: string, remoteUrl: string, name = 'wt1'): void {
  makeRepo(mainRoot, remoteUrl);
  const wtGitDir = join(mainRoot, '.git', 'worktrees', name);
  mkdirSync(wtGitDir, { recursive: true });
  writeFileSync(join(wtGitDir, 'commondir'), '../..\n');
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(join(worktreeRoot, '.git'), `gitdir: ${wtGitDir}\n`);
}

function writeMarker(dir: string, content: unknown): void {
  writeFileSync(join(dir, '.kopeng.json'), JSON.stringify(content));
}

describe('deriveProjectScope — git remote URL forms', () => {
  it('scp-like ssh: git@host:owner/repo.git', () => {
    const dir = freshDir();
    makeRepo(dir, 'git@github.com:djy89/kopeng.git');
    expect(deriveProjectScope(dir)).toEqual({ scope: 'project:djy89-kopeng', source: 'remote' });
  });

  it('ssh:// with user + port, no .git suffix', () => {
    const dir = freshDir();
    makeRepo(dir, 'ssh://git@github.com:22/djy89/kopeng');
    expect(deriveProjectScope(dir)).toEqual({ scope: 'project:djy89-kopeng', source: 'remote' });
  });

  it('https:// with trailing slash', () => {
    const dir = freshDir();
    makeRepo(dir, 'https://github.com/djy89/kopeng/');
    expect(deriveProjectScope(dir)).toEqual({ scope: 'project:djy89-kopeng', source: 'remote' });
  });

  it('http:// bare, no .git suffix', () => {
    const dir = freshDir();
    makeRepo(dir, 'http://github.com/djy89/kopeng');
    expect(deriveProjectScope(dir)).toEqual({ scope: 'project:djy89-kopeng', source: 'remote' });
  });

  it('deep GitLab-group path uses the LAST TWO segments', () => {
    const dir = freshDir();
    makeRepo(dir, 'https://gitlab.com/group/sub/repo.git');
    expect(deriveProjectScope(dir)).toEqual({ scope: 'project:sub-repo', source: 'remote' });
  });

  it('sanitizes characters outside [A-Za-z0-9._-] in owner/repo', () => {
    const dir = freshDir();
    makeRepo(dir, 'git@github.com:my org/my repo.git');
    expect(deriveProjectScope(dir)).toEqual({ scope: 'project:my-org-my-repo', source: 'remote' });
  });

  it('prefers the "origin" remote over other remote sections', () => {
    const dir = freshDir();
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(
      join(gitDir, 'config'),
      '[remote "upstream"]\n\turl = git@github.com:upstream-owner/upstream-repo.git\n' +
      '[remote "origin"]\n\turl = git@github.com:djy89/kopeng.git\n'
    );
    expect(deriveProjectScope(dir)).toEqual({ scope: 'project:djy89-kopeng', source: 'remote' });
  });

  it('falls back to the first remote section when there is no "origin"', () => {
    const dir = freshDir();
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(
      join(gitDir, 'config'),
      '[remote "upstream"]\n\turl = git@github.com:acme/widgets.git\n'
    );
    expect(deriveProjectScope(dir)).toEqual({ scope: 'project:acme-widgets', source: 'remote' });
  });
});

describe('deriveProjectScope — worktree unification', () => {
  it('two different temp dirs with the same remote derive the SAME scope', () => {
    const a = freshDir('a');
    const b = freshDir('b');
    makeRepo(a, 'git@github.com:djy89/kopeng.git');
    makeRepo(b, 'git@github.com:djy89/kopeng.git');
    expect(deriveProjectScope(a)).toEqual(deriveProjectScope(b));
    expect(deriveProjectScope(a).scope).toBe('project:djy89-kopeng');
  });

  it('a linked worktree (.git FILE + gitdir + commondir) resolves through the common dir', () => {
    const main = freshDir('main');
    const wt = freshDir('wt');
    makeWorktree(main, wt, 'git@github.com:djy89/kopeng.git');
    expect(deriveProjectScope(wt)).toEqual({ scope: 'project:djy89-kopeng', source: 'remote' });
  });

  it('two worktrees of the same repo land on the same scope', () => {
    const main = freshDir('main2');
    const wtOne = freshDir('wt-one');
    const wtTwo = freshDir('wt-two');
    makeWorktree(main, wtOne, 'git@github.com:djy89/kopeng.git', 'wt-one');
    // Second worktree shares the SAME main repo's remote — a fresh worktree
    // entry pointing at the same commondir target.
    const wtGitDir2 = join(main, '.git', 'worktrees', 'wt-two');
    mkdirSync(wtGitDir2, { recursive: true });
    writeFileSync(join(wtGitDir2, 'commondir'), '../..\n');
    writeFileSync(join(wtTwo, '.git'), `gitdir: ${wtGitDir2}\n`);
    expect(deriveProjectScope(wtOne)).toEqual(deriveProjectScope(wtTwo));
  });
});

describe('deriveProjectScope — different owners, same repo name', () => {
  it('derives different scopes for two owners of a repo named "api"', () => {
    const a = freshDir('owner-a');
    const b = freshDir('owner-b');
    makeRepo(a, 'git@github.com:acme/api.git');
    makeRepo(b, 'git@github.com:other/api.git');
    const scopeA = deriveProjectScope(a);
    const scopeB = deriveProjectScope(b);
    expect(scopeA.scope).toBe('project:acme-api');
    expect(scopeB.scope).toBe('project:other-api');
    expect(scopeA.scope).not.toBe(scopeB.scope);
  });
});

describe('deriveProjectScope — marker override', () => {
  it('a valid `.kopeng.json` `project` field wins over a real remote in the same dir', () => {
    const dir = freshDir();
    makeRepo(dir, 'git@github.com:djy89/kopeng.git');
    writeMarker(dir, { project: 'project:override-x' });
    expect(deriveProjectScope(dir)).toEqual({ scope: 'project:override-x', source: 'marker' });
  });

  it('a `client:` marker also qualifies', () => {
    const dir = freshDir();
    writeMarker(dir, { project: 'client:acme' });
    expect(deriveProjectScope(dir)).toEqual({ scope: 'client:acme', source: 'marker' });
  });

  it('a malformed child marker is skipped; a valid ancestor marker is honored', () => {
    const parent = freshDir('parent');
    writeMarker(parent, { project: 'client:acme-supply' });
    const child = join(parent, 'child');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, '.kopeng.json'), '{ not valid json');
    expect(deriveProjectScope(child)).toEqual({ scope: 'client:acme-supply', source: 'marker' });
  });

  it('ignores a `project` field that is a number, has no prefix, or is oversized', () => {
    const numeric = freshDir('numeric');
    writeMarker(numeric, { project: 42 });
    expect(deriveProjectScope(numeric)).toEqual({ scope: 'project:numeric', source: 'basename' });

    const noPrefix = freshDir('no-prefix');
    writeMarker(noPrefix, { project: 'just-a-name' });
    expect(deriveProjectScope(noPrefix)).toEqual({ scope: 'project:no-prefix', source: 'basename' });

    const oversized = freshDir('oversized');
    writeMarker(oversized, { project: 'project:' + 'x'.repeat(130) });
    expect(deriveProjectScope(oversized)).toEqual({ scope: 'project:oversized', source: 'basename' });
  });
});

describe('deriveProjectScope — basename fallback', () => {
  it('no .git anywhere on the walk falls back to basename', () => {
    const dir = freshDir('bare');
    const result = deriveProjectScope(dir);
    expect(result.source).toBe('basename');
    expect(result.scope).toBe(`project:bare`);
  });

  it('a .git dir with an unparseable config falls back to basename', () => {
    const dir = freshDir();
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'config'), 'this is not a valid git config at all\nno sections here\n');
    expect(deriveProjectScope(dir).source).toBe('basename');
  });

  it('a .git dir with a remote-less config falls back to basename', () => {
    const dir = freshDir();
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n');
    expect(deriveProjectScope(dir).source).toBe('basename');
  });

  it('a file:// remote is not a hosted identity — falls back to basename', () => {
    const dir = freshDir();
    makeRepo(dir, 'file:///home/user/other-repo');
    expect(deriveProjectScope(dir).source).toBe('basename');
  });

  it('a bare local path remote is not a hosted identity — falls back to basename', () => {
    const dir = freshDir();
    makeRepo(dir, '../sibling-repo');
    expect(deriveProjectScope(dir).source).toBe('basename');
  });

  it('a remote missing owner or repo (single path segment) falls back to basename', () => {
    const dir = freshDir();
    makeRepo(dir, 'https://github.com/just-one-segment');
    expect(deriveProjectScope(dir).source).toBe('basename');
  });
});

describe('deriveProjectScope — depth bound', () => {
  it('a .git 13 levels up is not found; falls back to basename', () => {
    const root = freshDir('depth-root');
    makeRepo(root, 'git@github.com:djy89/kopeng.git');
    let deep = root;
    for (let i = 0; i < 13; i++) {
      deep = join(deep, `d${i}`);
    }
    mkdirSync(deep, { recursive: true });
    expect(deriveProjectScope(deep).source).toBe('basename');
  });

  it('a .git well within the bound (5 levels up) IS found', () => {
    const root = freshDir('depth-ok');
    makeRepo(root, 'git@github.com:djy89/kopeng.git');
    let deep = root;
    for (let i = 0; i < 5; i++) {
      deep = join(deep, `d${i}`);
    }
    mkdirSync(deep, { recursive: true });
    expect(deriveProjectScope(deep)).toEqual({ scope: 'project:djy89-kopeng', source: 'remote' });
  });
});

describe('deriveProjectScope — no child_process dependency', () => {
  it('the module never imports node:child_process', () => {
    // Substring-match on "child_process" would false-positive on this file's own
    // doc comment explaining that it deliberately avoids it — check for an actual
    // import/require statement instead.
    const source = readFileSync(MODULE_PATH, 'utf-8');
    expect(source).not.toMatch(/(?:from\s+['"]|require\(['"])node:child_process['"]/);
    expect(source).not.toMatch(/(?:from\s+['"]|require\(['"])child_process['"]/);
  });
});

/**
 * readMarkerChain — the ONE ancestor walk shared with the recall hook's
 * readAnchorScopes (see tests/unit/anchor-scope-marker.test.ts for the
 * consumer-equivalence half). Full depth, nearest first, fail-open per level.
 */
describe('readMarkerChain — the shared walk', () => {
  it('returns every parsed marker on the path, nearest first', () => {
    const root = freshDir('chain-root');
    writeMarker(root, { project: 'client:top', scopes: ['client:top'] });
    const mid = join(root, 'mid');
    mkdirSync(mid, { recursive: true });
    writeMarker(mid, { project: 'project:middle' });
    const leaf = join(mid, 'leaf');
    mkdirSync(leaf, { recursive: true });

    // Runs to FULL depth — it does not stop at the first hit, because the other
    // consumer (readAnchorScopes) needs the ancestors too.
    expect(readMarkerChain(leaf)).toEqual([{ project: 'project:middle' }, { project: 'client:top', scopes: ['client:top'] }]);
  });

  it('skips an unparseable marker and keeps walking', () => {
    const root = freshDir('chain-failopen');
    writeMarker(root, { project: 'client:reachable' });
    const child = join(root, 'broken');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, '.kopeng.json'), 'not json at all');

    expect(readMarkerChain(child)).toEqual([{ project: 'client:reachable' }]);
  });

  it('returns [] when nothing on the path carries a marker', () => {
    expect(readMarkerChain(freshDir('chain-bare', 'a', 'b'))).toEqual([]);
  });

  it('honors its depth bound', () => {
    const root = freshDir('chain-depth');
    writeMarker(root, { project: 'client:too-far' });
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });

    expect(readMarkerChain(deep, { maxDepth: 2 })).toEqual([]);
    expect(readMarkerChain(deep, { maxDepth: 4 })).toEqual([{ project: 'client:too-far' }]);
  });
});

describe('deriveProjectScope — the injected marker chain', () => {
  it('a pre-read chain yields the same result as walking for itself', () => {
    const root = freshDir('inject-marker');
    makeRepo(root, 'git@github.com:djy89/kopeng.git');
    writeMarker(root, { project: 'client:override-wins' });
    const deep = join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });

    expect(deriveProjectScope(deep, { markers: readMarkerChain(deep) })).toEqual(deriveProjectScope(deep));
    expect(deriveProjectScope(deep).source).toBe('marker');
  });

  it('an empty chain still falls through to the remote, then basename', () => {
    const withRemote = freshDir('inject-remote');
    makeRepo(withRemote, 'git@github.com:djy89/kopeng.git');
    expect(deriveProjectScope(withRemote, { markers: [] })).toEqual({ scope: 'project:djy89-kopeng', source: 'remote' });

    const bare = freshDir('inject-bare');
    expect(deriveProjectScope(bare, { markers: [] }).source).toBe('basename');
  });
});
