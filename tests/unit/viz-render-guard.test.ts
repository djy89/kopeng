import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('viz render guard (T43)', () => {
  it('only requestRender() calls renderGraph() directly', () => {
    // No comment stripping: a prior version stripped comments first, and a
    // `/*`-looking substring inside an unrelated line comment (e.g. "/api/*")
    // opened a phantom block comment that swallowed ~2000 lines — including
    // real call sites — before the count was ever taken. Match the raw
    // source instead. Convention this enforces: no comment in viz/app.js may
    // spell the literal call string `renderGraph()` — a violating comment
    // would over-count and fail this test loudly, which is the safe failure
    // mode (vs. silently under-counting).
    const src = readFileSync(join(process.cwd(), 'viz', 'app.js'), 'utf8');
    const calls = src.match(/(?<!function\s)renderGraph\s*\(\s*\)/g) ?? [];
    // Exactly one direct call: the one inside requestRender().
    expect(calls).toHaveLength(1);
  });
});
