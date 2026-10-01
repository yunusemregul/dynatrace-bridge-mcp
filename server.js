#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import http from 'http';
import os from 'os';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

if (process.argv[2] === 'install-extension') {
  await (await import('./install-extension.js')).default(process.argv.slice(3));
  process.exit(0);
}

const log = (...parts) => console.error('[MCP Server]', ...parts);

let serving = false;

function surviveOrExit(kind, error) {
  log(`${kind}:`, error instanceof Error ? error.stack || error.message : error);
  if (!serving) process.exit(1);
}

process.on('unhandledRejection', (reason) => surviveOrExit('Unhandled rejection', reason));
process.on('uncaughtException', (error) => surviveOrExit('Uncaught exception', error));

const { createBridge, parseOriginList } = await import('./lib/bridge.js');
const { createContextFactory } = await import('./lib/context.js');
const { redact } = await import('./lib/format.js');
const { compareVersions } = await import('./lib/updates.js');

const NAME = 'dynatrace-bridge-mcp';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.join(ROOT, 'lib', 'tools');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const STDIO = process.argv.includes('--stdio') || !process.stdin.isTTY;

const WS_PORT = parseInt(process.env.WS_PORT || '47831', 10);
const MCP_PORT = parseInt(process.env.MCP_PORT || '47832', 10);
const HOST = process.env.HOST || '127.0.0.1';
const EXTENSION_WAIT_MS = parseInt(process.env.EXTENSION_WAIT_MS || '10000', 10);

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]'];
const ALLOWED_HOSTS = LOOPBACK_NAMES.flatMap(name => (MCP_PORT === 80 ? [name, `${name}:80`] : [`${name}:${MCP_PORT}`]));
const ALLOWED_ORIGINS = parseOriginList(process.env.DT_BRIDGE_ALLOWED_ORIGINS);
const REBINDING_PROTECTION = {
  enableDnsRebindingProtection: true,
  allowedHosts: ALLOWED_HOSTS,
  ...(ALLOWED_ORIGINS.length ? { allowedOrigins: ALLOWED_ORIGINS } : {}),
};

const STATE_DIR = path.join(os.homedir(), '.dynatrace-bridge');
const HANDOFF_SECRET_FILE = path.join(STATE_DIR, 'handoff-secret');
const HANDOFF_HEADER = 'x-dynatrace-bridge-handoff';
const HANDOFF_MAX_AGE_MS = 30000;
const HANDOFF_MAX_BODY_BYTES = 4096;

function readHandoffSecret() {
  try {
    const text = readFileSync(HANDOFF_SECRET_FILE, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
  } catch (e) {
    return null;
  }
}

function loadHandoffSecret() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    if (!readHandoffSecret()) {
      const draft = `${HANDOFF_SECRET_FILE}.${process.pid}.${randomBytes(4).toString('hex')}`;
      writeFileSync(draft, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
      try {
        linkSync(draft, HANDOFF_SECRET_FILE);
      } catch (e) {
        if (!readHandoffSecret()) renameSync(draft, HANDOFF_SECRET_FILE);
      }
      rmSync(draft, { force: true });
    }
    chmodSync(HANDOFF_SECRET_FILE, 0o600);
    return readHandoffSecret();
  } catch (e) {
    log(`No handoff secret at ${HANDOFF_SECRET_FILE} (${e.message}): this instance neither hands over to a newer one nor takes over from an older one`);
    return null;
  }
}

const handoffSecret = loadHandoffSecret();

function handoffProof(body, timestamp = Date.now()) {
  return `${timestamp}.${createHmac('sha256', handoffSecret).update(`${timestamp}\n${body}`).digest('hex')}`;
}

function validHandoffProof(header, body) {
  if (!handoffSecret || typeof header !== 'string') return false;
  const [timestamp, digest] = header.split('.');
  if (!/^\d{1,16}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(digest || '')) return false;
  if (Math.abs(Date.now() - Number(timestamp)) > HANDOFF_MAX_AGE_MS) return false;
  const expected = handoffProof(body, timestamp).split('.')[1];
  return timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(expected, 'hex'));
}

function sourceFiles() {
  const libDir = path.join(ROOT, 'lib');
  return [
    fileURLToPath(import.meta.url),
    ...readdirSync(libDir).filter(f => f.endsWith('.js')).map(f => path.join(libDir, f)),
    ...readdirSync(TOOLS_DIR).filter(f => f.endsWith('.js')).map(f => path.join(TOOLS_DIR, f)),
  ];
}

const UNORDERED_TOOLS = 1000;

const BUILD = Math.floor(Math.max(...sourceFiles().map(file => statSync(file).mtimeMs)));

async function loadTools() {
  const loaded = [];
  const owners = new Map();
  const rank = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  for (const file of readdirSync(TOOLS_DIR).filter(f => f.endsWith('.js')).sort()) {
    const module = await import(pathToFileURL(path.join(TOOLS_DIR, file)).href);
    if (!Array.isArray(module.tools)) throw new Error(`${path.relative(ROOT, path.join(TOOLS_DIR, file))} must export an array named \`tools\``);
    const fileOrder = rank(module.order, UNORDERED_TOOLS);
    for (const tool of module.tools) {
      const valid = tool && typeof tool.name === 'string' && tool.name
        && typeof tool.description === 'string' && tool.description
        && typeof tool.inputSchema === 'function' && typeof tool.handler === 'function';
      if (!valid) throw new Error(`${path.relative(ROOT, path.join(TOOLS_DIR, file))}: every tool needs name, description, inputSchema(ctx) and handler(args, ctx) (offending tool: ${JSON.stringify(tool?.name ?? null)})`);
      if (owners.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}" in ${path.relative(ROOT, path.join(TOOLS_DIR, file))} and ${owners.get(tool.name)}`);
      owners.set(tool.name, file);
      loaded.push({ tool, order: rank(tool.order, fileOrder), position: loaded.length });
    }
  }
  return loaded.sort((a, b) => a.order - b.order || a.position - b.position).map(entry => entry.tool);
}

const bridge = createBridge({ host: HOST, port: WS_PORT, extensionWaitMs: EXTENSION_WAIT_MS, log: (line) => log(line) });
const contextFor = createContextFactory({ bridge, version: VERSION, mcpPort: MCP_PORT });
const tools = await loadTools();
const toolsByName = new Map(tools.map(tool => [tool.name, tool]));

function errorResult(message) {
  return { content: [{ type: "text", text: `**Error:** ${redact(String(message))}` }], isError: true };
}

function missingArguments(schema, args) {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  return required.filter(name => args[name] === undefined || args[name] === null || args[name] === '');
}

function toContent(output) {
  if (typeof output !== 'string') throw new Error('the tool handler must return a markdown string');
  return [{ type: "text", text: redact(output) }];
}

async function runTool(name, args) {
  const tool = toolsByName.get(name);
  if (!tool) return errorResult(`Unknown tool \`${name}\`. Available tools: ${tools.map(t => t.name).join(', ')}`);
  const ctx = contextFor(tool.name, args);
  const startedAt = Date.now();
  try {
    const missing = missingArguments(tool.inputSchema(ctx), args);
    if (missing.length) return errorResult(`${missing.map(m => `\`${m}\``).join(', ')} ${missing.length > 1 ? 'are' : 'is'} required`);
    const content = toContent(await tool.handler(args, ctx));
    log(`${name} ok ${Date.now() - startedAt}ms`);
    return { content };
  } catch (error) {
    log(`${name} failed ${Date.now() - startedAt}ms: ${error?.code ? `${error.code} ` : ''}${redact(String(error?.message || error))}`);
    return errorResult(error?.message || error);
  }
}

function withVersionNote(handler) {
  let serverUpdateNoted = false;
  return async (request) => {
    const result = await handler(request);
    for (const note of bridge.updateNotes()) {
      if (note.kind === 'server-update') {
        if (serverUpdateNoted) continue;
        serverUpdateNoted = true;
      }
      result.content?.push({ type: "text", text: note.text });
    }
    return result;
  };
}

function listTools() {
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema(contextFor(tool.name, {})),
    })),
  };
}

function createMcpServer() {
  const server = new Server({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => listTools());
  server.setRequestHandler(CallToolRequestSchema, withVersionNote((request) => runTool(request.params.name, request.params.arguments || {})));
  return server;
}

const sessions = new Map();
const streamableSessions = new Map();

function refusal(req) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !ALLOWED_HOSTS.includes(host)) return 'the Host header is not a loopback name of this server';
  const origin = req.headers.origin;
  if (origin !== undefined) return ALLOWED_ORIGINS.includes(origin) ? null : 'this Origin is not allowed (see DT_BRIDGE_ALLOWED_ORIGINS)';
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'cross-site browser requests are not allowed';
  return null;
}

function parseTarget(req) {
  const raw = req.url;
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  try {
    const url = new URL(raw, 'http://localhost');
    return url.host === 'localhost' ? url : null;
  } catch (e) {
    return null;
  }
}

function answer(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function answerJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleHandoff(req, res) {
  if (req.method !== 'POST') return answer(res, 405, 'POST only');
  const remote = req.socket.remoteAddress;
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return answer(res, 403, 'loopback only');
  if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] || '')) return answer(res, 415, 'Content-Type must be application/json');
  const body = await readBody(req, HANDOFF_MAX_BODY_BYTES);
  if (body === null) return answer(res, 413, 'body too large');
  if (!validHandoffProof(req.headers[HANDOFF_HEADER], body)) {
    log('Refused a handoff request without a valid proof of the handoff secret');
    return answer(res, 403, 'handoff proof missing or invalid');
  }
  let peer = null;
  try { peer = JSON.parse(body); } catch (e) { peer = null; }
  if (!peer || typeof peer !== 'object' || !isNewerBuild(peer, { version: VERSION, build: BUILD })) {
    return answerJson(res, 409, { error: 'not newer', version: VERSION, build: BUILD });
  }
  if (!STDIO || handoffInProgress) {
    return answerJson(res, 409, { error: STDIO ? 'handoff in progress' : 'primary is not stdio-managed; restart it yourself', version: VERSION, build: BUILD });
  }
  handoffInProgress = true;
  answerJson(res, 202, { ok: true });
  setImmediate(() => demoteToProxy({ version: peer.version, build: Number(peer.build) }).catch((error) => {
    log(`Handing off failed: ${error?.message || error}`);
    process.exit(1);
  }));
}

async function handleHttp(req, res) {
  const refused = refusal(req);
  if (refused) return answer(res, 403, `Forbidden: ${refused}`);

  const origin = req.headers.origin;
  if (origin !== undefined) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  const url = parseTarget(req);
  if (!url) return answer(res, 400, 'Bad request: malformed request target');
  const pathname = url.pathname;

  if (pathname === '/health' && req.method === 'GET') {
    const status = bridge.status();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      name: NAME, version: VERSION, build: BUILD, stdio: STDIO, tools: tools.length,
      extension: { connected: status.connected, version: status.extensionVersion, environments: status.environments.map(e => e.name) },
    }));
    return;
  }

  if (pathname === '/handoff') return handleHandoff(req, res);

  if (pathname === '/mcp') {
    const sessionId = req.headers['mcp-session-id'];
    let transport = sessionId ? streamableSessions.get(sessionId) : undefined;

    if (!transport) {
      if (req.method !== 'POST') {
        res.writeHead(400);
        res.end('Unknown session');
        return;
      }
      transport = new StreamableHTTPServerTransport({
        ...REBINDING_PROTECTION,
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          streamableSessions.set(id, transport);
          log(`MCP client connected via Streamable HTTP (session: ${id}, total: ${streamableSessions.size})`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          streamableSessions.delete(transport.sessionId);
          log(`Streamable HTTP client disconnected (session: ${transport.sessionId}, remaining: ${streamableSessions.size})`);
        }
      };
      const server = createMcpServer();
      await server.connect(transport);
    }

    await transport.handleRequest(req, res);
    return;
  }

  if (pathname === '/sse' && req.method === 'GET') {
    const transport = new SSEServerTransport('/messages', res, REBINDING_PROTECTION);
    const server = createMcpServer();
    const sessionId = transport.sessionId;

    sessions.set(sessionId, { server, transport });
    log(`MCP client connected via SSE (session: ${sessionId}, total: ${sessions.size})`);

    res.on('close', () => {
      sessions.delete(sessionId);
      server.close();
      log(`MCP client disconnected (session: ${sessionId}, remaining: ${sessions.size})`);
    });

    await server.connect(transport);
    return;
  }

  if (pathname === '/messages' && req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    const session = sessions.get(sessionId);
    if (session) {
      await session.transport.handlePostMessage(req, res);
    } else {
      res.writeHead(400);
      res.end('Unknown session');
    }
    return;
  }

  answer(res, 404, 'Not found');
}

const httpServer = http.createServer((req, res) => {
  handleHttp(req, res).catch((error) => {
    log(`HTTP ${String(req.method).slice(0, 16)} request failed: ${error?.message || error}`);
    if (res.headersSent) res.destroy();
    else answer(res, 500, 'Internal error');
  });
});

function startHttpServer() {
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(MCP_PORT, HOST, () => {
      httpServer.on('error', (err) => log('HTTP server error:', err.message));
      resolve();
    });
  });
}

async function checkRunningPeer() {
  try {
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.name !== NAME || compareVersions(body.version, body.version) !== 0 || !Number.isFinite(body.build)) return null;
    return { name: NAME, version: body.version.trim(), build: body.build };
  } catch (e) {
    return null;
  }
}

function isNewerBuild(candidate, current) {
  const byVersion = compareVersions(candidate?.version, current?.version);
  if (byVersion === null) return false;
  if (byVersion !== 0) return byVersion > 0;
  return (Number(candidate?.build) || 0) > (Number(current?.build) || 0);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForPeer({ build = null, timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const peer = await checkRunningPeer();
    if (peer && (build === null || peer.build === build)) return peer;
    await sleep(300);
  }
  return null;
}

let stdioServer = null;
let handoffInProgress = false;

async function connectProxyClient() {
  const client = new Client({ name: `${NAME}-proxy`, version: VERSION }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`)));
  return client;
}

function bindProxyHandlers(server, client) {
  let current = client;
  let reconnecting = null;
  const reconnect = () => {
    if (!reconnecting) {
      log('Primary went away, waiting for a new one...');
      const stale = current;
      stale.onclose = null;
      reconnecting = (async () => {
        try { await stale.close(); } catch (e) { log(`Stale proxy client was already closed: ${e.message}`); }
        const peer = await waitForPeer({ timeoutMs: 30000 });
        if (!peer) {
          log('No primary came back within 30s, exiting');
          process.exit(1);
        }
        current = await connectProxyClient();
        watch(current);
        log(`Reattached to the new primary (v${peer.version})`);
        return current;
      })().finally(() => { reconnecting = null; });
    }
    return reconnecting;
  };
  const lostPrimary = (e) => e?.code === 400 || e?.code === 404
    || /Unknown session|Session not found|Server not initialized|Bad Request|ECONNREFUSED|fetch failed/.test(String(e?.message || e));
  const call = async (fn) => {
    const c = await (reconnecting || Promise.resolve(current));
    try {
      return await fn(c);
    } catch (e) {
      if (!lostPrimary(e)) throw e;
      return fn(await reconnect());
    }
  };
  server.setRequestHandler(ListToolsRequestSchema, () => call(c => c.listTools()));
  server.setRequestHandler(CallToolRequestSchema, (req) => call(c => c.callTool(req.params, undefined, { timeout: 600000 })));
  const watch = (c) => {
    c.onclose = () => { if (current === c && !reconnecting) reconnect().catch(() => process.exit(1)); };
  };
  watch(client);
}

async function attachStdioPrimary() {
  stdioServer = createMcpServer();
  stdioServer.onclose = () => log('stdio client disconnected (HTTP/WS still running)');
  await stdioServer.connect(new StdioServerTransport());
  log('MCP stdio transport attached');
}

async function demoteToProxy(peer) {
  log(`Newer instance (v${peer.version}) is taking over, handing off the browser bridge...`);
  await bridge.stop();
  for (const t of streamableSessions.values()) { try { await t.close(); } catch (e) { log(`Session close failed: ${e.message}`); } }
  for (const { server } of sessions.values()) { try { await server.close(); } catch (e) { log(`Session close failed: ${e.message}`); } }
  httpServer.closeAllConnections?.();
  await new Promise(r => httpServer.close(() => r()));

  const next = await waitForPeer({ build: peer.build, timeoutMs: 20000 });
  if (!next) {
    log('The new instance never came up, exiting');
    process.exit(1);
  }
  if (stdioServer) {
    const client = await connectProxyClient();
    bindProxyHandlers(stdioServer, client);
    stdioServer.onclose = () => process.exit(0);
  }
  handoffInProgress = false;
  log(`Now proxying stdio to the new primary (v${next.version})`);
}

async function takeOverFrom(peer) {
  if (!handoffSecret) return false;
  try {
    const body = JSON.stringify({ version: VERSION, build: BUILD });
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [HANDOFF_HEADER]: handoffProof(body) },
      body,
      signal: AbortSignal.timeout(3000),
    });
    if (res.status !== 202) {
      const reply = await res.json().catch(() => ({}));
      log(`Primary (v${peer.version}) declined handoff: ${typeof reply?.error === 'string' ? reply.error.slice(0, 200) : res.status}`);
      return false;
    }
  } catch (e) {
    log(`Handoff request failed: ${e.message}`);
    return false;
  }
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(300);
    try {
      await bridge.start();
      await startHttpServer();
      log(`Took over the browser bridge from v${peer.version}`);
      return true;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      await bridge.stop();
    }
  }
  log('Primary did not release the ports in time');
  return false;
}

async function runStdioProxy(peer) {
  const live = await waitForPeer({ timeoutMs: 30000 }) || peer;
  const client = await connectProxyClient();
  const server = new Server({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });
  bindProxyHandlers(server, client);
  server.onclose = () => process.exit(0);
  await server.connect(new StdioServerTransport());
  log(`Proxying stdio to the running instance (v${live.version}) at http://127.0.0.1:${MCP_PORT}/mcp`);
}

async function attachStdioBroken(message) {
  const server = new Server({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{
      name: 'dynatrace_bridge_status',
      description: 'The Dynatrace Bridge MCP server could not start. Call this to get the error and the fix to relay to the user.',
      inputSchema: { type: 'object', properties: {} },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, () => errorResult(message));
  server.onclose = () => process.exit(1);
  await server.connect(new StdioServerTransport());
}

function portInUseMessage(port, role) {
  const freeCmd = process.platform === 'win32'
    ? `netstat -ano | findstr :${port}, then taskkill /PID <pid> /F`
    : `lsof -ti:${port} | xargs kill`;
  const envVar = role === 'WebSocket' ? 'WS_PORT' : 'MCP_PORT';
  const extra = role === 'WebSocket' ? ' and set the same port in the extension popup' : '';
  return `Port ${port} (${role}) is in use by another program. Free it (${freeCmd}) or set ${envVar} in the MCP server config${extra}, then reconnect the MCP server.`;
}

async function main() {
  let failedPort = null;
  try {
    await bridge.start().catch(err => { failedPort = { port: WS_PORT, role: 'WebSocket' }; throw err; });
    await startHttpServer().catch(err => { failedPort = { port: MCP_PORT, role: 'HTTP' }; throw err; });
  } catch (err) {
    if (err.code !== 'EADDRINUSE') {
      log('Failed to start:', err.message);
      process.exit(1);
    }
    await bridge.stop();

    const peer = await checkRunningPeer();
    if (!peer) {
      const message = portInUseMessage(failedPort.port, failedPort.role);
      log(message);
      if (!STDIO) process.exit(1);
      await attachStdioBroken(message);
      return;
    }
    const tookOver = isNewerBuild({ version: VERSION, build: BUILD }, peer) && await takeOverFrom(peer);
    if (!tookOver) {
      if (STDIO) {
        await runStdioProxy(peer);
        return;
      }
      log(`Already running (v${peer.version}) at http://127.0.0.1:${MCP_PORT}/mcp. Nothing to do.`);
      process.exit(0);
    }
  }

  log(`Dynatrace Bridge MCP server v${VERSION} running with ${tools.length} tools`);
  log(`MCP endpoint (Streamable HTTP): http://localhost:${MCP_PORT}/mcp`);
  log(`MCP endpoint (legacy SSE): http://localhost:${MCP_PORT}/sse`);
  log(`Browser WebSocket: ws://localhost:${WS_PORT}`);
  log('Waiting for connections...');

  if (STDIO) await attachStdioPrimary();
}

main().then(() => {
  serving = true;
}, (err) => {
  log('Fatal:', err);
  process.exit(1);
});
