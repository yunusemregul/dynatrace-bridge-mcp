import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocket } from 'ws';
import { checkRequest, GET_ROUTES, matchesRoute } from '../lib/allowlist.js';
import { extensionIdFromKey, pinnedExtensionOrigin } from '../lib/bridge.js';
import { cases } from './allowlist-cases.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];
const cleanup = () => { while (cleanups.length) cleanups.pop()(); };
const fail = (msg) => { cleanup(); console.error(`✗ ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`✓ ${msg}`);

const sourceDirs = ['.', 'lib', 'lib/tools', 'scripts', 'extension'];
const jsFiles = sourceDirs.flatMap((dir) => {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) fail(`missing directory ${dir}`);
  return fs.readdirSync(full).filter(f => f.endsWith('.js')).map(f => path.join(full, f));
});
for (const file of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) fail(`syntax error in ${path.relative(root, file)}\n${r.stderr}`);
}
ok(`syntax of ${jsFiles.length} files`);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) fail(`manifest.json version ${manifest.version} != package.json ${pkg.version}`);
ok(`extension version matches package (${pkg.version})`);

let extensionId = null;
try {
  const der = Buffer.from(manifest.key, 'base64');
  const publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (!publicKey.export({ format: 'der', type: 'spki' }).equals(der)) throw new Error('not a canonical SPKI public key');
  extensionId = extensionIdFromKey(manifest.key);
} catch (e) {
  fail(`manifest.json "key" must be a base64 SPKI public key: ${e.message}`);
}
const extensionOrigin = `chrome-extension://${extensionId}`;
if (pinnedExtensionOrigin() !== extensionOrigin) fail(`the server pins ${pinnedExtensionOrigin()} but manifest.json gives ${extensionOrigin}`);
if (!fs.readFileSync(path.join(root, 'ARCHITECTURE.md'), 'utf8').includes(extensionId)) fail(`ARCHITECTURE.md does not state the extension id ${extensionId}`);
const broadPermissions = [...(manifest.permissions || []), ...(manifest.host_permissions || [])].filter(p => p === 'tabs' || /^(\*|https?):\/\//.test(p) || p === '<all_urls>');
if (broadPermissions.length) fail(`manifest.json asks for permissions the extension does not need at install time: ${broadPermissions.join(', ')}`);
ok(`extension id is pinned by manifest.json "key" (${extensionId}) and no site access is requested at install time`);

const extDir = path.join(root, 'extension');
const locales = Object.fromEntries(['en', 'tr'].map((l) => {
  const file = path.join(extDir, '_locales', l, 'messages.json');
  try {
    return [l, JSON.parse(fs.readFileSync(file, 'utf8'))];
  } catch (e) {
    return fail(`cannot parse _locales/${l}/messages.json: ${e.message}`);
  }
}));
const enKeys = Object.keys(locales.en).sort();
const trKeys = Object.keys(locales.tr).sort();
const missingTr = enKeys.filter(k => !locales.tr[k]);
const extraTr = trKeys.filter(k => !locales.en[k]);
if (missingTr.length || extraTr.length) fail(`en/tr messages differ. Missing in tr: ${missingTr.join(', ') || '-'}; only in tr: ${extraTr.join(', ') || '-'}`);
for (const l of ['en', 'tr']) {
  const empty = Object.entries(locales[l]).filter(([, v]) => typeof v?.message !== 'string' || !v.message).map(([k]) => k);
  if (empty.length) fail(`_locales/${l} has keys without a message: ${empty.join(', ')}`);
}
if (manifest.default_locale !== 'en') fail('manifest.json default_locale must be "en"');
const used = new Set();
for (const f of fs.readdirSync(extDir).filter(f => /\.(js|html|json)$/.test(f))) {
  const src = fs.readFileSync(path.join(extDir, f), 'utf8');
  const patterns = [
    /getMessage\(\s*["'](\w+)["']/g,
    /\b(?:t|msg)\(\s*["'](\w+)["']/g,
    /data-i18n(?:-placeholder|-title)?="(\w+)"/g,
    /__MSG_(\w+)__/g,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) used.add(m[1]);
}
const undefinedKeys = [...used].filter(k => !locales.en[k]);
if (undefinedKeys.length) fail(`message keys used but not defined: ${undefinedKeys.join(', ')}`);
ok(`i18n: en and tr have the same ${enKeys.length} keys, all ${used.size} referenced keys exist`);

const describeCase = ({ method, path: pathname, allowed }) => `${allowed ? 'allow' : 'deny'} ${String(method)} ${JSON.stringify(pathname)}`;
const extensionAllowlistFile = path.join(extDir, 'allowlist.js');
const extensionAllowlistSource = fs.readFileSync(extensionAllowlistFile, 'utf8');
if (/^\s*(import|export)\s/m.test(extensionAllowlistSource)) fail('extension/allowlist.js must be a classic script without imports or exports');
const sandbox = vm.createContext({});
sandbox.self = sandbox;
vm.runInContext(extensionAllowlistSource, sandbox, { filename: extensionAllowlistFile });
const extensionCheck = sandbox.DT_ALLOWLIST?.check;
if (typeof extensionCheck !== 'function') fail('extension/allowlist.js must define globalThis.DT_ALLOWLIST.check');
const verdictProblem = (verdict, allowed) => {
  if (verdict?.allowed !== allowed) return `answered allowed=${verdict?.allowed}`;
  if (!allowed && !(typeof verdict.reason === 'string' && verdict.reason)) return 'gave no reason';
  return null;
};
for (const entry of cases) {
  const serverProblem = verdictProblem(checkRequest(entry.method, entry.path), entry.allowed);
  if (serverProblem) fail(`lib/allowlist.js must ${describeCase(entry)} but ${serverProblem}`);
  const extensionProblem = verdictProblem(extensionCheck(entry.method, entry.path), entry.allowed);
  if (extensionProblem) fail(`extension/allowlist.js must ${describeCase(entry)} but ${extensionProblem}`);
}
const extensionRoutes = [...(sandbox.DT_ALLOWLIST.routes || [])];
if (JSON.stringify(extensionRoutes) !== JSON.stringify(GET_ROUTES)) fail('lib/allowlist.js and extension/allowlist.js list different routes');
const uncovered = GET_ROUTES.filter(route => !cases.some(c => c.allowed && c.method === 'GET' && matchesRoute(c.path, route)));
if (uncovered.length) fail(`scripts/allowlist-cases.js has no allowed case for: ${uncovered.join(', ')}`);
const allowedOther = cases.filter(c => c.allowed && c.method !== 'GET');
if (allowedOther.length) fail(`the bridge is GET-only, but these cases are marked allowed: ${allowedOther.map(describeCase).join(', ')}`);
if (!cases.some(c => !c.allowed && typeof c.path === 'string' && c.path.includes('%'))) fail('scripts/allowlist-cases.js has no percent-encoded case');

const pathUsers = [...fs.readdirSync(path.join(root, 'lib', 'tools')).map(f => path.join('lib', 'tools', f)), path.join('lib', 'context.js'), path.join('lib', 'entities.js')].filter(f => f.endsWith('.js'));
const usedPaths = new Map();
const unusable = [];
for (const relative of pathUsers) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const sendsOther = relative !== path.join('lib', 'context.js') && /\bmethod:\s*['"`](?!GET['"`])/.test(source);
  if (sendsOther || /\bctx\.post\(/.test(source)) unusable.push(`${relative} sends a request that is not a GET`);
  for (const [, literal] of source.matchAll(/['"`](\/rest\/[^'"`\s]*)['"`]/g)) {
    const sample = literal.replace(/\$\{[^}]*\}/g, 'ID-0');
    usedPaths.set(sample, relative);
    if (!checkRequest('GET', sample).allowed) unusable.push(`${relative} uses ${literal}, which the allow-list refuses`);
  }
}
if (unusable.length) fail(`tool code and allow-list disagree:\n  ${unusable.join('\n  ')}`);
const unusedRoutes = GET_ROUTES.filter(route => ![...usedPaths.keys()].some(sample => matchesRoute(sample, route)));
if (unusedRoutes.length) fail(`the allow-list has routes no tool uses: ${unusedRoutes.join(', ')}`);
ok(`allow-list: both implementations agree with all ${cases.length} cases (${cases.filter(c => !c.allowed).length} denied), GET only, and its ${GET_ROUTES.length} routes are exactly the ${usedPaths.size} paths the tools request`);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-verify-'));
cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
const install = spawnSync(process.execPath, [path.join(root, 'server.js'), 'install-extension', '--no-open', '--no-copy'], {
  encoding: 'utf8',
  env: { ...process.env, HOME: home, USERPROFILE: home },
});
const installedDir = path.join(home, '.dynatrace-bridge', 'extension');
if (install.status !== 0 || !fs.existsSync(path.join(installedDir, 'manifest.json'))) fail(`install-extension failed\n${install.stdout}${install.stderr}`);
const listFiles = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
});
const sourceFiles = listFiles(extDir);
const notCopied = sourceFiles.filter(f => !fs.existsSync(path.join(installedDir, f)));
if (notCopied.length) fail(`install-extension did not copy: ${notCopied.join(', ')}`);
const iconPaths = [...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {})];
const missingIcons = iconPaths.filter(icon => !fs.existsSync(path.join(installedDir, icon)));
if (iconPaths.length === 0 || missingIcons.length) fail(`installed extension lacks icons: ${missingIcons.join(', ') || 'manifest.json names none'}`);
ok(`install-extension copies the extension (${sourceFiles.length} files, icons included)`);

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const mcpPort = await freePort();
const wsPort = await freePort();
const server = spawn(process.execPath, [path.join(root, 'server.js'), '--stdio'], {
  env: {
    ...process.env, HOME: home, USERPROFILE: home, MCP_PORT: String(mcpPort), WS_PORT: String(wsPort), HOST: '127.0.0.1',
    DT_BRIDGE_UPDATE_CHECK: '0', DT_BRIDGE_ALLOWED_ORIGINS: '', DT_BRIDGE_EXTENSION_ORIGINS: '',
  },
  stdio: ['pipe', 'ignore', 'pipe'],
});
let serverLog = '';
server.stderr.on('data', (chunk) => { serverLog = `${serverLog}${chunk}`.slice(-4000); });
cleanups.push(() => server.kill());
const watchdog = setTimeout(() => fail(`the server check did not finish within 60s\n${serverLog}`), 60000);

let health = null;
for (let i = 0; i < 40 && !health && server.exitCode === null; i++) {
  await new Promise(r => setTimeout(r, 250));
  try {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/health`);
    if (res.ok) health = await res.json();
  } catch (e) {
    health = null;
  }
}
if (health?.name !== 'dynatrace-bridge-mcp' || health.version !== pkg.version) fail(`server /health did not respond correctly: ${JSON.stringify(health)}\n${serverLog}`);
if (!(health.tools >= 5)) fail(`server loaded ${health.tools} tools, expected at least the 5 core tools`);
ok(`server starts, loads ${health.tools} tools and answers /health`);

const client = new Client({ name: 'dynatrace-bridge-verify', version: pkg.version }, { capabilities: {} });
let listed;
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`)));
  listed = (await client.listTools()).tools;
  await client.close();
} catch (e) {
  fail(`tools/list over MCP failed: ${e.message}\n${serverLog}`);
}
if (!Array.isArray(listed) || listed.length !== health.tools) fail(`tools/list returned ${listed?.length} tools, /health reports ${health.tools}`);
const names = listed.map(tool => tool.name);
const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
if (duplicates.length) fail(`duplicate tool names: ${duplicates.join(', ')}`);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const schemaProblem = (tool) => {
  if (typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(tool.name)) return 'name must be snake_case';
  if (typeof tool.description !== 'string' || !tool.description.trim()) return 'description is empty';
  const schema = tool.inputSchema;
  if (!isObject(schema) || schema.type !== 'object') return 'inputSchema.type must be "object"';
  if (schema.properties !== undefined && !isObject(schema.properties)) return 'inputSchema.properties must be an object';
  const properties = schema.properties || {};
  const untyped = Object.entries(properties).filter(([, property]) => !isObject(property) || !(typeof property.type === 'string' || Array.isArray(property.type) || property.enum || property.anyOf || property.oneOf)).map(([key]) => key);
  if (untyped.length) return `properties without a type: ${untyped.join(', ')}`;
  if (schema.required !== undefined && !Array.isArray(schema.required)) return 'inputSchema.required must be an array';
  const unknown = (schema.required || []).filter(key => !(key in properties));
  if (unknown.length) return `required names unknown properties: ${unknown.join(', ')}`;
  return null;
};
const invalid = listed.map(tool => [tool.name, schemaProblem(tool)]).filter(([, problem]) => problem);
if (invalid.length) fail(`invalid tool definitions:\n${invalid.map(([name, problem]) => `  ${name}: ${problem}`).join('\n')}`);
ok(`tools/list over MCP: ${listed.length} tools, unique names, object input schemas`);

const send = ({ method = 'GET', target = '/health', headers = {}, body = null }) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: mcpPort, method, path: target, headers: { ...(body === null ? {} : { 'content-length': Buffer.byteLength(body) }), ...headers } }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    res.on('error', reject);
  });
  req.setTimeout(5000, () => req.destroy(new Error('no answer within 5s')));
  req.on('error', reject);
  req.end(body === null ? undefined : body);
});
const expectStatus = async (what, request, status) => {
  let answer;
  try {
    answer = await send(request);
  } catch (e) {
    fail(`${what}: the request failed (${e.message})\n${serverLog}`);
  }
  if (answer.status !== status) fail(`${what}: expected HTTP ${status}, got ${answer.status} ${answer.text.slice(0, 200)}\n${serverLog}`);
  return answer;
};
const stillUp = async (after) => {
  const answer = await expectStatus(`/health after ${after}`, {}, 200);
  if (JSON.parse(answer.text).name !== pkg.name) fail(`/health after ${after} answered something else`);
};
const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'verify', version: '0' } } });
const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const foreignOrigin = { origin: 'https://attacker.example' };
const foreignHost = { host: `attacker.example:${mcpPort}` };

for (const target of ['/health', '/sse', '/mcp', '/messages?sessionId=x', '/handoff']) {
  const method = target === '/health' || target === '/sse' ? 'GET' : 'POST';
  const body = method === 'POST' ? initialize : null;
  const headers = method === 'POST' ? mcpHeaders : {};
  await expectStatus(`${method} ${target} with a foreign Origin`, { method, target, body, headers: { ...headers, ...foreignOrigin } }, 403);
  await expectStatus(`${method} ${target} with Origin: null`, { method, target, body, headers: { ...headers, origin: 'null' } }, 403);
  await expectStatus(`${method} ${target} with a foreign Host`, { method, target, body, headers: { ...headers, ...foreignHost } }, 403);
  await expectStatus(`${method} ${target} as a cross-site browser request`, { method, target, body, headers: { ...headers, 'sec-fetch-site': 'cross-site' } }, 403);
}
const preflight = await expectStatus('a preflight from a foreign Origin', { method: 'OPTIONS', target: '/mcp', headers: { ...foreignOrigin, 'access-control-request-method': 'POST' } }, 403);
if (preflight.headers['access-control-allow-origin']) fail('a refused preflight still carries Access-Control-Allow-Origin');
const plainHealth = await expectStatus('/health without Origin', {}, 200);
if (plainHealth.headers['access-control-allow-origin']) fail('/health sends Access-Control-Allow-Origin although no origin is allowed');
for (const name of ['localhost', '127.0.0.1', '[::1]']) {
  await expectStatus(`/health with Host ${name}`, { headers: { host: `${name}:${mcpPort}` } }, 200);
}
ok('HTTP: foreign Origin, Origin null, foreign Host and cross-site requests get 403 on every endpoint; loopback Host names work; no CORS headers');

for (const target of ['//', '//attacker.example/mcp', '/\\attacker.example']) {
  await expectStatus(`GET ${target}`, { target }, 400);
}
await stillUp('malformed request targets');
ok('HTTP: malformed request targets get 400 and the server stays up');

const secretFile = path.join(home, '.dynatrace-bridge', 'handoff-secret');
if (!fs.existsSync(secretFile)) fail(`the server did not create ${secretFile}`);
const secret = fs.readFileSync(secretFile, 'utf8').trim();
if (!/^[0-9a-f]{64}$/.test(secret)) fail('the handoff secret is not 32 random bytes in hex');
if (process.platform !== 'win32' && (fs.statSync(secretFile).mode & 0o777) !== 0o600) fail(`the handoff secret has mode ${(fs.statSync(secretFile).mode & 0o777).toString(8)}, expected 600`);
const proof = (body, timestamp = Date.now(), key = secret) => `${timestamp}.${crypto.createHmac('sha256', key).update(`${timestamp}\n${body}`).digest('hex')}`;
const newer = JSON.stringify({ version: '999.0.0', build: Number.MAX_SAFE_INTEGER });
const older = JSON.stringify({ version: '0.0.1', build: 1 });
const json = { 'content-type': 'application/json' };
const handoff = 'x-dynatrace-bridge-handoff';
await expectStatus('/handoff without a proof', { method: 'POST', target: '/handoff', body: newer, headers: json }, 403);
await expectStatus('/handoff with the secret of another user', { method: 'POST', target: '/handoff', body: newer, headers: { ...json, [handoff]: proof(newer, Date.now(), 'f'.repeat(64)) } }, 403);
await expectStatus('/handoff with a proof for another body', { method: 'POST', target: '/handoff', body: newer, headers: { ...json, [handoff]: proof(older) } }, 403);
await expectStatus('/handoff with a stale proof', { method: 'POST', target: '/handoff', body: newer, headers: { ...json, [handoff]: proof(newer, Date.now() - 3600000) } }, 403);
await expectStatus('/handoff as a simple form POST', { method: 'POST', target: '/handoff', body: newer, headers: { 'content-type': 'text/plain', [handoff]: proof(newer) } }, 415);
await expectStatus('GET /handoff', { target: '/handoff' }, 405);
await expectStatus('/handoff with a valid proof from an older build', { method: 'POST', target: '/handoff', body: older, headers: { ...json, [handoff]: proof(older) } }, 409);
await stillUp('refused handoff requests');
ok('handoff: refused without a fresh proof of the 0600 secret and without Content-Type application/json; a valid proof is accepted');

const connectExtension = (origin) => new Promise((resolve) => {
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`, origin === null ? {} : { origin });
  const timer = setTimeout(() => { socket.terminate(); resolve({ accepted: false, reason: 'timeout' }); }, 5000);
  socket.once('open', () => { clearTimeout(timer); resolve({ accepted: true, socket }); });
  socket.once('unexpected-response', (req, res) => { clearTimeout(timer); socket.terminate(); resolve({ accepted: false, reason: `HTTP ${res.statusCode}` }); });
  socket.once('error', (e) => { clearTimeout(timer); resolve({ accepted: false, reason: e.message }); });
});
const strangers = [null, 'https://attacker.example', 'null', `http://127.0.0.1:${wsPort}`, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', `${extensionOrigin}.attacker.example`, 'moz-extension://00000000-0000-4000-8000-000000000001'];
for (const origin of strangers) {
  const attempt = await connectExtension(origin);
  if (attempt.accepted) {
    attempt.socket.terminate();
    fail(`the WebSocket accepted ${origin === null ? 'a client without Origin' : `Origin ${origin}`}`);
  }
}
const extension = await connectExtension(extensionOrigin);
if (!extension.accepted) fail(`the WebSocket refused the pinned extension origin ${extensionOrigin}: ${extension.reason}\n${serverLog}`);
cleanups.push(() => extension.socket.terminate());
const offered = [
  { name: 'good', envId: 'ignored', origin: 'https://dynatrace.example', basePath: '/e/abc12345' },
  { name: 'good', origin: 'https://dynatrace.example', basePath: '/e/duplicate' },
  { name: 'bad\nname', origin: 'https://dynatrace.example', basePath: '/e/abc12345' },
  { name: 'backtick`', origin: 'https://dynatrace.example', basePath: '/e/abc12345' },
  { name: 'script', origin: 'javascript:alert(1)', basePath: '/e/abc12345' },
  { name: 'file', origin: 'file:///etc', basePath: '/e/abc12345' },
  { name: 'userinfo', origin: 'https://user:pass@dynatrace.example', basePath: '/e/abc12345' },
  { name: 'path', origin: 'https://dynatrace.example/x', basePath: '/e/abc12345' },
  { name: 'nobase', origin: 'https://dynatrace.example', basePath: '' },
  { name: 'traversal', origin: 'https://dynatrace.example', basePath: '/e/abc/../x' },
  { name: 'query', origin: 'https://dynatrace.example', basePath: '/e/abc?x' },
];
const welcomed = new Promise((resolve) => extension.socket.on('message', (raw) => { if (JSON.parse(raw).type === 'WELCOME') resolve(true); }));
extension.socket.send(JSON.stringify({ type: 'HELLO', version: '<b>1.0.0</b>', environments: offered }));
if (!(await Promise.race([welcomed, new Promise(r => setTimeout(() => r(false), 5000))]))) fail(`the server did not answer HELLO with WELCOME\n${serverLog}`);
const seen = JSON.parse((await expectStatus('/health after HELLO', {}, 200)).text).extension;
if (JSON.stringify(seen.environments) !== JSON.stringify(['good']) || seen.version !== null) fail(`HELLO validation let invalid values through: ${JSON.stringify(seen)}`);
extension.socket.terminate();
ok(`WebSocket: only ${extensionOrigin} may connect (${strangers.length} other origins refused), HELLO environments and version are validated`);

clearTimeout(watchdog);
cleanup();
process.exit(0);
