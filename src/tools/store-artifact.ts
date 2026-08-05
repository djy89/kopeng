export const storeArtifactTool = {
  definition: {
    name: 'store_artifact',
    description: 'Store a file/artifact in MinIO object storage, linked to a memory. Use for large files, binary data, images, or documents that are too big for memory content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        memory_id: { type: 'number', description: 'The memory ID to link this artifact to' },
        filename: { type: 'string', description: 'Original filename (e.g., "report.pdf", "diagram.png")' },
        content_base64: { type: 'string', description: 'File content encoded as base64 string' },
        content_type: { type: 'string', description: 'MIME type (e.g., "application/pdf", "image/png")', default: 'application/octet-stream' },
      },
      required: ['memory_id', 'filename', 'content_base64'],
    },
  },

  handler: async (args: Record<string, unknown>, apiUrl: string) => {
    const response = await fetch(`${apiUrl}/api/artifacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Mutating endpoint — admin-key gated when the server has ADMIN_API_KEY set.
        ...(process.env.ADMIN_API_KEY ? { 'x-api-key': process.env.ADMIN_API_KEY } : {}),
      },
      body: JSON.stringify({
        memory_id: args.memory_id,
        filename: args.filename,
        content_base64: args.content_base64,
        content_type: args.content_type || 'application/octet-stream',
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to store artifact: ${response.status} ${err}`);
    }

    const result = await response.json() as { data: { key: string; filename: string; size: number; memoryId: number } };
    const d = result.data;
    return {
      content: [{
        type: 'text' as const,
        text: `Artifact stored: ${d.filename} (${d.size} bytes)\nKey: ${d.key}\nLinked to memory: ${d.memoryId}`,
      }],
    };
  },
};
