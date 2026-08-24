import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = process.cwd();
const packageVersion = (
  JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }
).version;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('release version identity', () => {
  it('uses package.json for REST/config identity even when a stale env override exists', async () => {
    vi.stubEnv('MCP_SERVER_VERSION', '0.0.0-stale');
    vi.resetModules();
    const { config } = await import('../../src/config/config.js');
    expect(config.mcp.version).toBe(packageVersion);
  });

  it('.env.example points to package.json instead of pinning a second version', () => {
    const example = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
    expect(example).not.toMatch(/^MCP_SERVER_VERSION=/m);
    expect(example).toMatch(/version.*package\.json/i);
  });

  it('reports the package version in the real MCP initialize handshake', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(repoRoot, 'src', 'index.ts'),
      ],
      cwd: repoRoot,
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'version-identity-test', version: '0.0.0' },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.version).toBe(packageVersion);
    } finally {
      await client.close();
    }
  }, 30_000);
});
