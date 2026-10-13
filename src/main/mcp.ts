import { randomBytes } from 'crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { McpInfo } from '../shared/automation';
import { findCell } from '../shared/state';
import type { AutomationService } from './automation';
import { callTool, describeError, mcpInstructions, toolsForRole } from './mcpTools';

export interface McpServerOptions {
  /** Per-token request budget: `burst` requests at once, refilled at `perSecond`. `false` disables it (benchmarks). */
  rateLimit?: { burst: number; perSecond: number } | false;
  /** Simultaneous requests: per token (a waiting agent holds one) and in total. */
  maxInFlightPerToken?: number;
  maxInFlight?: number;
}
const MAX_BODY = 256 * 1024;
/** Safety net for a single tool result; the tools already shape and truncate their output. */
const MAX_RESULT_CHARS = 60000;

export class AjzakomatorMcpServer {
  private http: HttpServer | null = null;
  private tokens = new Map<string, string>();
  private tokenOf = new Map<string, string>();
  private buckets = new Map<string, { tokens: number; at: number }>();
  private inFlightByToken = new Map<string, number>();
  private connectedCells = new Set<string>();
  private connections = new Set<Server>();
  private info: McpInfo = { running: false };
  private readonly limits: Required<McpServerOptions>;
  constructor(private readonly service: AutomationService, options: McpServerOptions = {}) {
    this.limits = { rateLimit: { burst: 120, perSecond: 60 }, maxInFlightPerToken: 8, maxInFlight: 256, ...options };
  }
  getInfo(): McpInfo { return { ...this.info, configuredCellIds: [...this.tokenOf.keys()], connectedCellIds: [...this.connectedCells] }; }
  issueToken(cellId: string): string {
    this.revokeCell(cellId);
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, cellId);
    this.tokenOf.set(cellId, token);
    return token;
  }
  revokeCell(cellId: string): void {
    this.connectedCells.delete(cellId);
    const token = this.tokenOf.get(cellId);
    if (token === undefined) return;
    this.tokenOf.delete(cellId);
    this.tokens.delete(token);
    this.buckets.delete(token);
    this.inFlightByToken.delete(token);
  }
  async start(): Promise<void> {
    this.http = createServer((req, res) => { void this.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'MCP request failed.' }));
      else if (!res.writableEnded) res.end();
    }); });
    this.http.requestTimeout = 30000;
    this.http.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(0, '127.0.0.1', () => { this.http!.off('error', reject); resolve(); });
    });
    const port = (this.http.address() as AddressInfo).port;
    this.info = { running: true, url: `http://127.0.0.1:${port}/mcp` };
  }
  private allow(token: string): boolean {
    const limit = this.limits.rateLimit;
    if (!limit) return true;
    const now = Date.now();
    const bucket = this.buckets.get(token) ?? { tokens: limit.burst, at: now };
    bucket.tokens = Math.min(limit.burst, bucket.tokens + ((now - bucket.at) / 1000) * limit.perSecond);
    bucket.at = now;
    this.buckets.set(token, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = this.info.url!;
    const port = new URL(url).port;
    // DNS-rebinding hardening: only the literal local origins may talk to the server.
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host ?? '')) { res.writeHead(403).end(); return; }
    if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) { res.writeHead(403).end(); return; }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const actorId = token ? this.tokens.get(token) : undefined;
    if (!token || !actorId) { res.writeHead(401).end(); return; }
    this.connectedCells.add(actorId);
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    const inFlight = this.inFlightByToken.get(token) ?? 0;
    if (!this.allow(token) || inFlight >= this.limits.maxInFlightPerToken || this.connections.size >= this.limits.maxInFlight) {
      res.writeHead(429, { 'Retry-After': '1' }).end(); return;
    }
    this.inFlightByToken.set(token, inFlight + 1);
    const abort = new AbortController();
    const found = findCell(this.service.state.get(), actorId);
    const role = this.service.roleOf(actorId);
    const server = new Server({ name: 'ajzakomator', version: '1.1.0' }, {
      capabilities: { tools: {} },
      instructions: mcpInstructions(role, { cellId: actorId, name: found?.cell.name, project: found?.project.name }),
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsForRole(this.service.roleOf(actorId)) }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      let value: unknown;
      try {
        // Recheck the token on every call, including calls racing with a cell restart.
        if (this.tokens.get(token) !== actorId) throw new Error('Agent connection has expired.');
        value = await callTool(params.name, params.arguments, { service: this.service, actorId, signal: abort.signal });
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: describeError(error) }] };
      }
      if (value === null) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
      let text = JSON.stringify(value) ?? 'null';
      if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}...[result truncated; narrow the request]`;
      return { content: [{ type: 'text' as const, text }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY });
    this.connections.add(server);
    res.once('close', () => {
      abort.abort();
      this.connections.delete(server);
      const left = (this.inFlightByToken.get(token) ?? 1) - 1;
      if (this.tokens.has(token)) this.inFlightByToken.set(token, Math.max(0, left));
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      this.connections.delete(server);
      await server.close().catch(() => undefined);
      throw error;
    }
  }
  async stop(): Promise<void> {
    this.tokens.clear();
    this.tokenOf.clear();
    this.buckets.clear();
    this.inFlightByToken.clear();
    this.connectedCells.clear();
    this.info = { running: false };
    await Promise.all([...this.connections].map((server) => server.close().catch(() => undefined)));
    this.connections.clear();
    this.http?.closeAllConnections();
    if (this.http?.listening) await new Promise<void>((resolve) => this.http!.close(() => resolve()));
    this.http = null;
  }
}
