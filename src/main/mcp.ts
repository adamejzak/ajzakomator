import { randomBytes } from 'crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
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
  /** Monotonic millisecond clock; replaceable in tests. Wall-clock changes must never refill or drain the budget. */
  now?: () => number;
  /** Where internal failures are reported (the crash log); never gets tool arguments. */
  log?: (message: string) => void;
}
const MAX_BODY = 256 * 1024;

/**
 * The MCP SDK (with its zod/ajv graph, about 300 ms to load) is loaded on the first agent request, not at startup: listening
 * only needs Node's http, so the port is known at once and the window does not wait for the SDK (0.9.4).
 */
let sdkLoad: Promise<McpSdk> | undefined;
type McpSdk = Awaited<ReturnType<typeof importSdk>>;
async function importSdk() {
  const [server, http, types] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);
  return {
    Server: server.Server, StreamableHTTPServerTransport: http.StreamableHTTPServerTransport,
    CallToolRequestSchema: types.CallToolRequestSchema, ListToolsRequestSchema: types.ListToolsRequestSchema, ErrorCode: types.ErrorCode, McpError: types.McpError,
  };
}
/** Loads the SDK once (a failed load is tried again by the next request). */
export function loadMcpSdk(): Promise<McpSdk> {
  sdkLoad ??= importSdk().catch((error: unknown) => { sdkLoad = undefined; throw error; });
  return sdkLoad;
}
/** Safety net for a single tool result; the tools already shape and truncate their output. */
const MAX_RESULT_CHARS = 60000;
/** A cell counts as connected while its agent listed or called tools this recently. */
export const CONNECTED_WINDOW_MS = 10 * 60_000;

/** A result over the cap stays valid JSON: the beginning travels as a string, with a hint to narrow the request. */
export function capResult(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const hint = 'narrow the request (filters, limit/offset paging, verbose:false)';
  // JSON escaping can grow the partial text, so it is cut until the whole envelope fits.
  for (let room = max - 200; room > 0; room = Math.floor(room * 0.8)) {
    const out = JSON.stringify({ truncated: true, hint, partial: text.slice(0, room) });
    if (out.length <= max) return out;
  }
  return JSON.stringify({ truncated: true, hint });
}

export class UnimuxMcpServer {
  private http: HttpServer | null = null;
  private tokens = new Map<string, string>();
  private tokenOf = new Map<string, string>();
  private buckets = new Map<string, { tokens: number; at: number }>();
  private inFlightByToken = new Map<string, number>();
  /** Requests in progress per token; revoking the token aborts them (a waiting wait_for ends at once). */
  private aborts = new Map<string, Set<AbortController>>();
  /** When each cell's agent last listed or called tools successfully (monotonic clock). */
  private lastSeen = new Map<string, number>();
  private connections = new Set<Server>();
  private info: McpInfo = { running: false };
  private readonly limits: Required<Omit<McpServerOptions, 'log'>>;
  private readonly log: (message: string) => void;
  private readonly changeListeners = new Set<() => void>();
  constructor(private readonly service: AutomationService, options: McpServerOptions = {}) {
    const { log, ...limits } = options;
    this.limits = { rateLimit: { burst: 120, perSecond: 60 }, maxInFlightPerToken: 8, maxInFlight: 256, now: () => performance.now(), ...limits };
    this.log = log ?? (() => undefined);
  }
  getInfo(): McpInfo {
    const now = this.limits.now();
    const connected = [...this.lastSeen].filter(([cellId, at]) => this.tokenOf.has(cellId) && now - at < CONNECTED_WINDOW_MS).map(([cellId]) => cellId);
    return { ...this.info, configuredCellIds: [...this.tokenOf.keys()], connectedCellIds: connected };
  }
  /** Called when the info changes (a token issued or revoked, a cell seen for the first time, the server started). */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }
  private changed(): void { for (const listener of this.changeListeners) listener(); }
  /** A successful tools/list or tools/call: the agent's MCP client really works. */
  private seen(cellId: string): void {
    const first = !this.lastSeen.has(cellId) || this.limits.now() - this.lastSeen.get(cellId)! >= CONNECTED_WINDOW_MS;
    this.lastSeen.set(cellId, this.limits.now());
    if (first) this.changed();
  }
  issueToken(cellId: string): string {
    this.revokeCell(cellId);
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, cellId);
    this.tokenOf.set(cellId, token);
    this.changed();
    return token;
  }
  revokeCell(cellId: string): void {
    this.lastSeen.delete(cellId);
    const token = this.tokenOf.get(cellId);
    if (token === undefined) return;
    this.changed();
    this.tokenOf.delete(cellId);
    this.tokens.delete(token);
    this.buckets.delete(token);
    this.inFlightByToken.delete(token);
    for (const controller of this.aborts.get(token) ?? []) controller.abort();
    this.aborts.delete(token);
  }
  async start(): Promise<void> {
    if (this.http?.listening) return;
    const http = createServer((req, res) => { void this.handle(req, res).catch((error: unknown) => {
      // Name and message only: never the request body (tool arguments may carry user text).
      this.log(`MCP request failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`.slice(0, 300));
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'MCP request failed.' }));
      else if (!res.writableEnded) res.end();
    }); });
    http.requestTimeout = 30000;
    http.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve(); });
    });
    http.on('error', (error) => this.log(`MCP server error: ${error.message}`.slice(0, 300)));
    this.http = http;
    const port = (http.address() as AddressInfo).port;
    this.info = { running: true, url: `http://127.0.0.1:${port}/mcp` };
    this.changed();
  }
  private allow(token: string): boolean {
    const limit = this.limits.rateLimit;
    if (!limit) return true;
    const now = this.limits.now();
    const bucket = this.buckets.get(token) ?? { tokens: limit.burst, at: now };
    // A clock that moved backwards refills nothing (never negative) and becomes the new reference point.
    bucket.tokens = Math.min(limit.burst, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * limit.perSecond);
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
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    const inFlight = this.inFlightByToken.get(token) ?? 0;
    // Cheap concurrency checks first, so a rejected request does not also spend rate budget.
    if (inFlight >= this.limits.maxInFlightPerToken || this.connections.size >= this.limits.maxInFlight || !this.allow(token)) {
      res.writeHead(429, { 'Retry-After': '1' }).end(); return;
    }
    this.inFlightByToken.set(token, inFlight + 1);
    const abort = new AbortController();
    const controllers = this.aborts.get(token) ?? new Set<AbortController>();
    controllers.add(abort);
    this.aborts.set(token, controllers);
    let sdk: McpSdk;
    try { sdk = await loadMcpSdk(); } catch (error) { this.release(token, abort, controllers); throw error; }
    const { Server, StreamableHTTPServerTransport, CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } = sdk;
    const found = findCell(this.service.state.get(), actorId);
    const role = this.service.roleOf(actorId);
    const server = new Server({ name: 'unimux', version: '1.1.0' }, {
      capabilities: { tools: {} },
      instructions: mcpInstructions(role, { cellId: actorId, name: found?.cell.name, project: found?.project.name }),
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = toolsForRole(this.service.roleOf(actorId));
      if (this.tokens.get(token) === actorId) this.seen(actorId);
      return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      let value: unknown;
      try {
        // Recheck the token on every call, including calls racing with a cell restart.
        if (this.tokens.get(token) !== actorId) throw new Error('Agent connection has expired.');
        value = await callTool(params.name, params.arguments, { service: this.service, actorId, signal: abort.signal });
        // Revoked while the call was running (a waiting wait_for is aborted by revokeCell): do not hand out the result.
        if (this.tokens.get(token) !== actorId) throw new Error('Agent connection has expired.');
      } catch (error) {
        if (this.tokens.get(token) === actorId) this.seen(actorId); // an error answer still means the client works
        return { isError: true, content: [{ type: 'text' as const, text: describeError(error) }] };
      }
      if (value === null) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
      this.seen(actorId);
      return { content: [{ type: 'text' as const, text: capResult(JSON.stringify(value) ?? 'null') }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY });
    this.connections.add(server);
    res.once('close', () => {
      this.release(token, abort, controllers);
      this.connections.delete(server);
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
  /** A request ended: its abort fires and its in-flight slot is given back. */
  private release(token: string, abort: AbortController, controllers: Set<AbortController>): void {
    abort.abort();
    controllers.delete(abort);
    const left = (this.inFlightByToken.get(token) ?? 1) - 1;
    if (this.tokens.has(token)) this.inFlightByToken.set(token, Math.max(0, left));
  }
  async stop(): Promise<void> {
    this.tokens.clear();
    this.tokenOf.clear();
    this.buckets.clear();
    this.inFlightByToken.clear();
    for (const set of this.aborts.values()) for (const controller of set) controller.abort();
    this.aborts.clear();
    this.lastSeen.clear();
    this.info = { running: false };
    await Promise.all([...this.connections].map((server) => server.close().catch(() => undefined)));
    this.connections.clear();
    this.http?.closeAllConnections();
    if (this.http?.listening) await new Promise<void>((resolve) => this.http!.close(() => resolve()));
    this.http = null;
  }
}
