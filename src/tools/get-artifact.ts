export const getArtifactTool = {
  definition: {
    name: 'get_artifact',
    description: 'Retrieve an artifact from MinIO storage or list artifacts linked to a memory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'Artifact key to retrieve. Get this from store_artifact result or list mode.' },
        memory_id: { type: 'number', description: 'List all artifacts linked to this memory ID' },
        mode: { type: 'string', enum: ['get', 'list', 'url'], description: 'Mode: get (download), list (list by memory), url (get presigned URL)', default: 'list' },
      },
      required: [],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const mode = (args.mode as string) || 'list';

    if (mode === 'list') {
      if (!args.memory_id) {
        return { content: [{ type: 'text' as const, text: 'Error: memory_id is required for list mode' }] };
      }

      const response = await fetch(`${apiUrl}/api/artifacts?memory_id=${args.memory_id}`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) throw new Error(`Failed to list artifacts: ${response.status}`);

      const result = await response.json() as { data: { key: string; filename: string; size: number; uploadedAt: string }[] };
      const artifacts = result.data;

      if (!artifacts.length) {
        return { content: [{ type: 'text' as const, text: `No artifacts linked to memory ${args.memory_id}` }] };
      }

      const list = artifacts.map(a => `  - ${a.filename} (${a.size} bytes) — key: ${a.key}`).join('\n');
      return { content: [{ type: 'text' as const, text: `Artifacts for memory ${args.memory_id}:\n${list}` }] };
    }

    if (mode === 'url') {
      if (!args.key) return { content: [{ type: 'text' as const, text: 'Error: key is required for url mode' }] };

      const response = await fetch(`${apiUrl}/api/artifacts/url?key=${encodeURIComponent(args.key as string)}`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) throw new Error(`Failed to get artifact URL: ${response.status}`);

      const result = await response.json() as { data: { url: string; expires_in: number } };
      return { content: [{ type: 'text' as const, text: `Presigned URL (expires in ${result.data.expires_in}s):\n${result.data.url}` }] };
    }

    // mode === 'get'
    if (!args.key) return { content: [{ type: 'text' as const, text: 'Error: key is required for get mode' }] };

    const response = await fetch(`${apiUrl}/api/artifacts/${encodeURIComponent(args.key as string)}`, {
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      if (response.status === 404) return { content: [{ type: 'text' as const, text: 'Artifact not found' }] };
      throw new Error(`Failed to get artifact: ${response.status}`);
    }

    const result = await response.json() as { data: { filename: string; size: number; content_base64: string; contentType: string } };
    const d = result.data;

    // For text files, show content; for binary, show metadata
    if (d.contentType?.startsWith('text/') || d.size < 10000) {
      const decoded = Buffer.from(d.content_base64, 'base64').toString('utf-8');
      return { content: [{ type: 'text' as const, text: `Artifact: ${d.filename} (${d.size} bytes)\n\n${decoded}` }] };
    }

    return {
      content: [{
        type: 'text' as const,
        text: `Artifact: ${d.filename} (${d.size} bytes, ${d.contentType})\nContent is binary — use "url" mode to get a download link`,
      }],
    };
  },
};
