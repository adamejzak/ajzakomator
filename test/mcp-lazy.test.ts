import { describe, expect, it, vi } from 'vitest';
import { startMcpHarness } from './helpers/mcpHarness';

// The MCP SDK is loaded on the first agent request, not when the server starts listening (0.9.4 startup).
const loaded = vi.hoisted(() => ({ count: 0 }));
vi.mock('@modelcontextprotocol/sdk/server/index.js', async (importOriginal) => {
  loaded.count++;
  return importOriginal();
});

describe('MCP SDK loading', () => {
  it('listens without the SDK and loads it on the first request', async () => {
    const h = await startMcpHarness(undefined, { rateLimit: false });
    try {
      expect(h.server.getInfo().running).toBe(true);
      expect(loaded.count).toBe(0);
      const response = await fetch(h.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${h.server.issueToken(h.worker.id)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(response.status).toBe(200);
      expect(loaded.count).toBe(1);
    } finally {
      await h.server.stop();
    }
  });
});
