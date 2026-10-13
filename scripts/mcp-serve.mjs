// Starts the ajzakomator MCP server standalone with fake automation (one project: coordinator, worker, reviewer) so that
// `claude mcp` / `codex mcp` can be pointed at it with a scratch CLAUDE_CONFIG_DIR / CODEX_HOME. Prints JSON, then waits.
// Usage: node scripts/mcp-serve.mjs   (Ctrl+C to stop). No model calls are made by anything here.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

const dir = mkdtempSync(join(tmpdir(), 'ajz-mcp-serve-'));
const out = join(dir, 'harness.mjs');
await build({ entryPoints: [resolve('test/helpers/mcpHarness.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['electron', 'node-pty'], logLevel: 'silent', banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" } });
const { startMcpHarness } = await import(pathToFileURL(out).href);
const h = await startMcpHarness(undefined, { rateLimit: false });
console.log(JSON.stringify({ url: h.url, coordinator: { cellId: h.coordinator.id, token: h.server.issueToken(h.coordinator.id) }, worker: { cellId: h.worker.id, token: h.server.issueToken(h.worker.id) } }));
const stop = async () => { await h.server.stop(); rmSync(dir, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
setInterval(() => undefined, 1 << 30);
