/**
 * Review finding 4 — src/index.ts (the MCP stdio entry) used to hardcode its
 * own `<projectRoot>/.env` dotenv path, bypassing the Ruling 7/8 resolution
 * entirely: a packaged `kopeng mcp` (projectRoot inside node_modules) loaded
 * no ADMIN_API_KEY and every write tool 401'd.
 *
 * src/index.ts calls `main()` unconditionally at module load (no direct-run
 * guard like src/cli/index.ts or src/server.ts), so importing it in a test
 * would try to start a real MCP stdio server — not something to do here.
 * This is a STRUCTURAL pin instead: assert the source text actually wires
 * the shared `resolveEnvFile` (src/config/env-resolution.ts) into its
 * `dotenv.config()` call, and never reintroduces a hand-rolled path.join
 * that bypasses it. If a future edit removes the import or the call site,
 * this test fails loudly instead of silently regressing per-entry-point.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SOURCE = fs.readFileSync(path.resolve(HERE, '../../src/index.ts'), 'utf8');

describe('MCP stdio entry env resolution (review finding 4)', () => {
  it('imports resolveEnvFile from the shared env-resolution module', () => {
    expect(INDEX_SOURCE).toMatch(/import\s*\{\s*resolveEnvFile\s*\}\s*from\s*['"]\.\/config\/env-resolution\.js['"]/);
  });

  it('never imports config.ts wholesale (that module eagerly validates every env var)', () => {
    expect(INDEX_SOURCE).not.toMatch(/from ['"]\.\/config\/config\.js['"]/);
  });

  it('its dotenv.config() call actually USES resolveEnvFile, not a hand-rolled projectRoot/.env join', () => {
    expect(INDEX_SOURCE).toMatch(/dotenv\.config\(\{\s*path:\s*resolveEnvFile\(/);
  });
});
