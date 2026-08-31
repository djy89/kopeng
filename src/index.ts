import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';

import { storeMemoryTool } from './tools/store-memory.js';
import { searchMemoriesTool } from './tools/search-memories.js';
import { getMemoryTool } from './tools/get-memory.js';
import { updateMemoryTool } from './tools/update-memory.js';
import { listMemoriesTool } from './tools/list-memories.js';
import { archiveMemoryTool } from './tools/archive-memory.js';
import { evalRetrievalTool } from './tools/eval-retrieval.js';
// Phase 2: Neo4j
import { traverseMemoryTool } from './tools/traverse-memory.js';
// Phase 3: Redis
import { setContextTool } from './tools/set-context.js';
import { getContextTool } from './tools/get-context.js';
// Phase 4: MinIO
import { storeArtifactTool } from './tools/store-artifact.js';
import { getArtifactTool } from './tools/get-artifact.js';
// Auto-discovery
import { triggerDiscoveryTool } from './tools/trigger-discovery.js';
import { triggerDreamTool } from './tools/trigger-dream.js';
// Dreaming review/apply surface (D1.3)
import { listPendingDreamsTool } from './tools/list-pending-dreams.js';
import { getDreamDiffTool } from './tools/get-dream-diff.js';
import { resolveDreamTool } from './tools/resolve-dream.js';
import { getOperatorConfigTool, setOperatorConfigTool } from './tools/get-set-operator-config.js';
import { KOPENG_VERSION } from './version.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
// Review finding 4: this stdio entry used to hardcode <projectRoot>/.env,
// so a packaged `kopeng mcp` (projectRoot = .../node_modules/kopeng, which
// never carries a .env) loaded no ADMIN_API_KEY and every write tool 401'd.
// Route through the SAME Ruling 8 resolution src/config/config.ts uses — via
// the pure, dependency-light env-resolution module (not config.ts itself,
// which eagerly validates every env var; this entry must still answer
// --version/tool-listing even with a poisoned launch environment).
import { resolveEnvFile } from './config/env-resolution.js';
import { ENV_FILE as PACKAGED_ENV_FILE } from './cli/paths.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Non-overriding .env fallback (launch env always wins): gives the stdio
// client MEMORY_API_URL and the T27 ADMIN_API_KEY without every MCP client
// config having to plumb them through its env block.
dotenv.config({ path: resolveEnvFile({ env: process.env, projectRoot, packagedEnvFile: PACKAGED_ENV_FILE }) });

const API_URL = process.env.MEMORY_API_URL || 'http://localhost:3200';

interface Tool {
  definition: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>, apiUrl: string) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

async function main() {
  const tools: Tool[] = [
    storeMemoryTool,
    searchMemoriesTool,
    getMemoryTool,
    updateMemoryTool,
    listMemoriesTool,
    archiveMemoryTool,
    evalRetrievalTool,
    // Phase 2: Neo4j
    traverseMemoryTool,
    // Phase 3: Redis
    setContextTool,
    getContextTool,
    // Phase 4: MinIO
    storeArtifactTool,
    getArtifactTool,
    // Auto-discovery
    triggerDiscoveryTool,
    // Dreaming (memory consolidation)
    triggerDreamTool,
    listPendingDreamsTool,
    getDreamDiffTool,
    resolveDreamTool,
    getOperatorConfigTool,
    setOperatorConfigTool,
  ];

  const server = new Server(
    { name: 'kopeng', version: KOPENG_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: tools.map(t => t.definition) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const tool = tools.find(t => t.definition.name === name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    try {
      return await tool.handler(args || {}, API_URL);
    } catch (error: any) {
      // Connection errors get a friendly message
      if (error.cause?.code === 'ECONNREFUSED' || error.code === 'ECONNREFUSED') {
        throw new McpError(
          ErrorCode.InternalError,
          `Memory service unavailable at ${API_URL}. Is the server running?`
        );
      }
      throw new McpError(
        ErrorCode.InternalError,
        error.message || 'Tool execution failed'
      );
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

main().catch((error) => {
  process.stderr.write(`kopeng MCP startup failed: ${error.message || error}\n`);
  process.exit(1);
});
