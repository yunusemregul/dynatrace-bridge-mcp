import { WebSocketServer } from 'ws';
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { checkRequest } from './allowlist.js';
import { redact } from './format.js';
import { PACKAGE_NAME, REGISTRY_URL, compareVersions, createUpdateChecker, packageVersion, parseVersion, updateCheckEnabled } from './updates.js';

export const EXTENSION_NAME = 'Dynatrace Bridge';

const MEBIBYTE = 1024 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * MEBIBYTE;
export const MAX_RESPONSE_BYTES_CEILING = 48 * MEBIBYTE;
export const WS_MAX_PAYLOAD_BYTES = 72 * MEBIBYTE;

export const ERROR_CODES = [
  'NO_EXTENSION',
  'NO_ENVIRONMENT',
  'UNKNOWN_ENVIRONMENT',
  'NO_TAB',
  'SESSION_EXPIRED',
  'BLOCKED',
  'HTTP_ERROR',
  'RESPONSE_TOO_LARGE',
  'POLL_TIMEOUT',
  'TIMEOUT',
  'INTERNAL',
];

export class BridgeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function createLane(concurrency, gapMs) {
  const waiting = [];
  let active = 0;
  let nextStartAt = 0;
  let timer = null;
  const pump = () => {
    while (active < concurrency && waiting.length > 0) {
      const wait = nextStartAt - Date.now();
      if (wait > 0) {
        if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            pump();
          }, wait);
        }
        return;
      }
      const run = waiting.shift();
      active++;
      run().finally(() => {
        active--;
        nextStartAt = Date.now() + gapMs;
        pump();
      });
    }
  };
  return (task) => new Promise((resolve, reject) => {
    waiting.push(() => Promise.resolve().then(task).then(resolve, reject));
    pump();
  });
}

const ENVIRONMENT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;
const ENVIRONMENT_BASE_PATH = /^\/e\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const MAX_ENVIRONMENTS = 50;
const MAX_LOGGED_REJECTIONS = 20;
const REJECTION_HINT_MS = 60000;
const EXTENSION_ORIGIN_SHAPE = /^(chrome|moz)-extension:\/\/[a-z0-9-]{1,64}$/;
const ORIGIN_SHAPE = /^[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+$/;

export function extensionIdFromKey(key) {
  const digest = createHash('sha256').update(Buffer.from(String(key), 'base64')).digest('hex').slice(0, 32);
  return [...digest].map(digit => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}

export function pinnedExtensionOrigin(manifestUrl = new URL('../extension/manifest.json', import.meta.url)) {
  try {
    const { key } = JSON.parse(readFileSync(manifestUrl, 'utf8'));
    return typeof key === 'string' && key ? `chrome-extension://${extensionIdFromKey(key)}` : null;
  } catch (e) {
    return null;
  }
}

export function parseOriginList(value) {
  return String(value ?? '').split(/[\s,]+/).map(entry => entry.replace(/\/+$/, '')).filter(entry => ORIGIN_SHAPE.test(entry));
}

export function allowedExtensionOrigins(env = process.env) {
  return [...new Set([pinnedExtensionOrigin(), ...parseOriginList(env.DT_BRIDGE_EXTENSION_ORIGINS)].filter(Boolean))];
}

export function normalizeEnvironment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!ENVIRONMENT_NAME.test(name)) return null;
  if (typeof raw.origin !== 'string' || typeof raw.basePath !== 'string') return null;
  let url = null;
  try {
    url = new URL(raw.origin);
  } catch (e) {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== raw.origin) return null;
  const base = raw.basePath.match(ENVIRONMENT_BASE_PATH);
  if (!base) return null;
  return { name, envId: base[1], origin: url.origin, basePath: raw.basePath };
}

function normalizeEnvironments(list) {
  const seen = new Set();
  const accepted = [];
  for (const raw of Array.isArray(list) ? list.slice(0, MAX_ENVIRONMENTS) : []) {
    const env = normalizeEnvironment(raw);
    if (!env || seen.has(env.name.toLowerCase())) continue;
    seen.add(env.name.toLowerCase());
    accepted.push(env);
  }
  return accepted;
}

function dynatraceMessage(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  try {
    const error = JSON.parse(text.slice(start))?.error;
    if (typeof error?.message !== 'string') return null;
    const violations = Array.isArray(error.constraintViolations)
      ? error.constraintViolations.map(v => v?.message).filter(Boolean)
      : [];
    return [error.message, ...violations].join(' ');
  } catch (e) {
    const partial = text.slice(start).match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return partial ? partial[1].replace(/\\(.)/g, '$1') : null;
  }
}

function excerpt(text, max = 400) {
  const raw = String(text ?? '');
  const value = redact(dynatraceMessage(raw) ?? raw.replace(/^HTTP \d{3}[^:{]*(:\s*|$)/, '')).replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function createBridge({
  host = '127.0.0.1',
  port = 47831,
  extensionWaitMs = 10000,
  defaultTimeoutMs = 90000,
  timeoutGraceMs = 5000,
  v2Concurrency = 4,
  analysisGapMs = 250,
  maxPayloadBytes = WS_MAX_PAYLOAD_BYTES,
  serverVersion = process.env.DT_BRIDGE_SERVER_VERSION || packageVersion(),
  updateCheck = {},
  extensionOrigins = allowedExtensionOrigins(),
  log = (line) => console.error(`[MCP Server] ${line}`),
} = {}) {
  let wss = null;
  let connectionCounter = 0;
  let lastUsed = null;
  let lastSeenEnvironments = [];
  const connections = [];
  const pending = new Map();
  const lanes = new Map();
  const readyWaiters = new Set();
  const rejectedOrigins = new Set();
  let rejectedExtension = null;

  const updates = createUpdateChecker({
    enabled: updateCheckEnabled(),
    url: process.env.DT_BRIDGE_UPDATE_URL || REGISTRY_URL,
    log,
    ...updateCheck,
    onChange: () => {
      for (const connection of connections) {
        if (connection.ready) welcome(connection);
      }
    },
  });

  function welcome(connection) {
    if (connection.socket.readyState !== 1) return;
    connection.socket.send(JSON.stringify({ type: 'WELCOME', serverVersion, latestVersion: updates.latestVersion() }));
  }

  const newestFirst = () => connections.filter(c => c.ready).reverse();
  const isReady = () => connections.some(c => c.ready);
  const copyEnvironments = (list) => list.map(e => ({ ...e }));

  function liveEnvironments() {
    const seen = new Set();
    const list = [];
    for (const connection of newestFirst()) {
      for (const env of connection.environments) {
        const key = env.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(env);
      }
    }
    return list;
  }

  const knownEnvironments = () => (isReady() ? liveEnvironments() : lastSeenEnvironments);

  function route(name) {
    const wanted = name.toLowerCase();
    for (const connection of newestFirst()) {
      if (connection.socket.readyState !== 1) continue;
      const env = connection.environments.find(e => e.name.toLowerCase() === wanted);
      if (env) return { connection, env };
    }
    return null;
  }

  function noteRejectedOrigin(origin) {
    const shown = typeof origin === 'string' ? JSON.stringify(origin.slice(0, 200)) : 'no Origin header';
    if (EXTENSION_ORIGIN_SHAPE.test(origin)) rejectedExtension = { origin, at: Date.now() };
    if (rejectedOrigins.has(shown)) return;
    if (rejectedOrigins.size < MAX_LOGGED_REJECTIONS) rejectedOrigins.add(shown);
    log(`Rejected a WebSocket connection (${shown}): only ${extensionOrigins.join(', ') || 'no origin'} may connect. Further attempts from it are not logged.`);
  }

  function reportedConnection() {
    if (lastUsed && lastUsed.ready && connections.includes(lastUsed)) return lastUsed;
    return newestFirst()[0] || null;
  }

  function start() {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({
        host,
        port,
        maxPayload: maxPayloadBytes,
        verifyClient: ({ origin }) => {
          if (typeof origin === 'string' && extensionOrigins.includes(origin)) return true;
          noteRejectedOrigin(origin);
          return false;
        },
      });
      server.once('listening', () => {
        server.on('error', (err) => log(`WebSocket server error: ${err.message}`));
        wss = server;
        log(extensionOrigins.length
          ? `Accepting the browser extension from: ${extensionOrigins.join(', ')}`
          : 'No extension origin is allowed: extension/manifest.json has no key and DT_BRIDGE_EXTENSION_ORIGINS is not set');
        updates.start();
        resolve();
      });
      server.once('error', reject);
      server.on('connection', handleConnection);
    });
  }

  async function stop() {
    const server = wss;
    wss = null;
    updates.stop();
    failPending(() => true, 'The MCP server is shutting down its browser bridge.');
    connections.length = 0;
    lastUsed = null;
    if (!server) return;
    for (const socket of server.clients) {
      try { socket.terminate(); } catch (e) { log(`Could not terminate a socket: ${e.message}`); }
    }
    await new Promise(resolve => server.close(() => resolve()));
  }

  function failPending(match, message) {
    for (const [requestId, entry] of pending) {
      if (!match(entry)) continue;
      pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.reject(new BridgeError('NO_EXTENSION', message));
    }
  }

  function dropConnection(connection) {
    const index = connections.indexOf(connection);
    if (index === -1) return;
    if (connection.ready && connections.filter(c => c.ready).length === 1) lastSeenEnvironments = copyEnvironments(liveEnvironments());
    connections.splice(index, 1);
    if (lastUsed === connection) lastUsed = null;
    log(`Browser extension #${connection.id} disconnected (${connections.length} still connected)`);
    const advice = connections.some(c => c.ready)
      ? 'Another browser with the extension is still connected; retry the request.'
      : 'Check that the browser is open and the extension is enabled, then retry.';
    failPending(entry => entry.connection === connection, `The ${EXTENSION_NAME} extension disconnected while the request was running. ${advice}`);
  }

  function handleConnection(socket) {
    const connection = { id: ++connectionCounter, socket, connectedAt: Date.now(), ready: false, version: null, environments: [] };
    connections.push(connection);
    log(`Browser extension #${connection.id} connected via WebSocket (${connections.length} connected)`);

    socket.on('close', () => dropConnection(connection));
    socket.on('error', (err) => log(`WebSocket error on extension #${connection.id}: ${err.message}`));
    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        log('Ignored a WebSocket frame that is not JSON');
        return;
      }
      handleMessage(connection, msg);
    });
  }

  function handleMessage(connection, msg) {
    if (msg?.type === 'PING') {
      connection.socket.send(JSON.stringify({ type: 'PONG' }));
      return;
    }
    if (msg?.type === 'HELLO') {
      if (!connections.includes(connection)) return;
      const offered = Array.isArray(msg.environments) ? msg.environments.length : 0;
      connection.environments = normalizeEnvironments(msg.environments);
      connection.version = parseVersion(msg.version) ? msg.version.trim() : null;
      connection.ready = true;
      const refused = offered - connection.environments.length;
      log(`Extension #${connection.id} ${connection.version || 'unknown version'}, environments: ${connection.environments.map(e => e.name).join(', ') || '(none configured)'}${refused > 0 ? ` (${refused} refused: invalid name, origin or base path, or a duplicate name)` : ''}`);
      welcome(connection);
      for (const wake of [...readyWaiters]) wake();
      return;
    }
    if (msg?.type === 'DT_RESULT') {
      const entry = pending.get(msg.requestId);
      if (!entry || entry.connection !== connection) return;
      pending.delete(msg.requestId);
      clearTimeout(entry.timer);
      entry.settle(msg);
    }
  }

  function noExtensionError() {
    if (rejectedExtension && Date.now() - rejectedExtension.at < REJECTION_HINT_MS) {
      return new BridgeError('NO_EXTENSION', `No browser extension is connected: an extension at ${rejectedExtension.origin} tried to connect and was refused, because this server only accepts the ${EXTENSION_NAME} build it ships (${extensionOrigins.join(', ') || 'none'}). Tell the user to run \`npx -y ${PACKAGE_NAME}@latest install-extension\`, click reload on the extension in the browser's extensions page and add the environment again in its popup. A fork or another browser can be allowed with the DT_BRIDGE_EXTENSION_ORIGINS environment variable of the MCP server.`);
    }
    return new BridgeError('NO_EXTENSION', `No browser extension is connected. Open the browser where the ${EXTENSION_NAME} extension is installed and make sure its popup shows it as connected (WebSocket port ${port}). If it is not installed, run \`npx -y dynatrace-bridge-mcp install-extension\`.`);
  }

  function waitForExtension(waitMs = extensionWaitMs) {
    if (isReady()) return Promise.resolve();
    log(`No browser extension connected, waiting up to ${waitMs / 1000}s...`);
    return new Promise((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer);
        readyWaiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(() => {
        readyWaiters.delete(wake);
        reject(noExtensionError());
      }, waitMs);
      readyWaiters.add(wake);
    });
  }

  function findIn(environments, name) {
    if (name === null || name === undefined || name === '') return environments[0] || null;
    const wanted = String(name).trim().toLowerCase();
    return environments.find(e => e.name.toLowerCase() === wanted) || null;
  }

  function findEnvironment(name) {
    const env = findIn(knownEnvironments(), name);
    return env ? { ...env } : null;
  }

  function resolveEnvironment(name) {
    const environments = liveEnvironments();
    if (environments.length === 0) {
      throw new BridgeError('NO_ENVIRONMENT', `No Dynatrace environment is configured in the ${EXTENSION_NAME} extension. Open Dynatrace in the browser, click the extension icon and choose "Add this environment".`);
    }
    const env = findIn(environments, name);
    if (!env) {
      throw new BridgeError('UNKNOWN_ENVIRONMENT', `Unknown environment "${name}". Configured environments: ${environments.map(e => e.name).join(', ')}.`);
    }
    return env;
  }

  function laneFor(env, kind) {
    const key = `${env.name.toLowerCase()}|${kind}`;
    if (!lanes.has(key)) lanes.set(key, kind === 'v2' ? createLane(v2Concurrency, 0) : createLane(1, analysisGapMs));
    return lanes.get(key);
  }

  function normalizeRequest(request) {
    if (!request || typeof request !== 'object') throw new BridgeError('INTERNAL', 'dt() needs a request object with at least a path');
    const method = String(request.method || 'GET').toUpperCase();
    const path = request.path;
    const verdict = checkRequest(method, path);
    if (!verdict.allowed) {
      throw new BridgeError('BLOCKED', `Request blocked by the read-only allow-list: ${verdict.reason} (${method} ${typeof path === 'string' ? path : JSON.stringify(path)}).`);
    }
    const timeoutMs = typeof request.timeoutMs === 'number' && request.timeoutMs > 0 ? Math.round(request.timeoutMs) : defaultTimeoutMs;
    const wire = {
      method,
      path,
      query: request.query && typeof request.query === 'object' ? request.query : {},
      poll: request.poll !== false,
      timeoutMs,
    };
    if (request.maxBytes !== undefined && request.maxBytes !== null) wire.maxBytes = request.maxBytes;
    return wire;
  }

  function errorFromResult(msg, env, describe) {
    const known = ERROR_CODES.includes(msg.errorCode);
    const code = known ? msg.errorCode : (typeof msg.status === 'number' && msg.status >= 400 ? 'HTTP_ERROR' : 'INTERNAL');
    const detail = excerpt(msg.error);
    const extra = { status: typeof msg.status === 'number' ? msg.status : null, environment: env.name, detail };
    const home = `${env.origin}${env.basePath}/`;
    if (code === 'SESSION_EXPIRED' && msg.loginTab === 'opened') {
      return new BridgeError(code, `Dynatrace needs a login for environment "${env.name}". The extension has just opened a Dynatrace tab in the user's browser and brought it to the front (${home}), and it shows a login page. Ask the user to log in to Dynatrace in that tab and then retry.`, extra);
    }
    if (code === 'SESSION_EXPIRED' && msg.loginTab === 'waiting') {
      return new BridgeError(code, `Dynatrace still needs a login for environment "${env.name}". The tab the extension opened for it (${home}) is still on a login page and has been brought to the front again. Ask the user to finish logging in to Dynatrace in that tab and then retry.`, extra);
    }
    if (code === 'SESSION_EXPIRED') {
      return new BridgeError(code, `The Dynatrace session for environment "${env.name}" has expired or is not logged in. Ask the user to log in to Dynatrace again in the tab at ${home} and then retry.`, extra);
    }
    if (code === 'HTTP_ERROR') {
      const hints = {
        403: ' The logged-in Dynatrace user lacks the permission for this data.',
        404: ' The entity or resource does not exist in this environment or was not seen in the requested window.',
        429: ' Dynatrace is rate limiting; wait a moment before retrying.',
      };
      return new BridgeError(code, `Dynatrace answered HTTP ${extra.status ?? '?'} for ${describe}${detail ? `: ${detail.replace(/\.?$/, '.')}` : '.'}${hints[extra.status] || ''}`, extra);
    }
    if (code === 'RESPONSE_TOO_LARGE') {
      const reason = detail || 'The response exceeded the size limit.';
      const advice = /narrower filters/.test(reason) ? '' : ' Use a shorter time window or narrower filters.';
      return new BridgeError(code, `Dynatrace answered ${describe} with more data than the bridge relays. ${reason}${advice}`, extra);
    }
    if (code === 'POLL_TIMEOUT') {
      return new BridgeError(code, `Dynatrace did not finish ${describe} in time. Narrow the time window or add filters, then retry.`, extra);
    }
    if (code === 'NO_TAB') {
      return new BridgeError(code, detail || `The extension could not find or open a Dynatrace tab for environment "${env.name}" (${home}).`, extra);
    }
    return new BridgeError(code, detail || `The extension reported ${code}.`, extra);
  }

  function unroutable(env) {
    if (!isReady()) return noExtensionError();
    const names = liveEnvironments().map(e => e.name).join(', ') || '(none)';
    return new BridgeError('UNKNOWN_ENVIRONMENT', `Environment "${env.name}" is no longer available: the browser that had it configured disconnected or removed it. Configured environments: ${names}.`);
  }

  function exchange({ frame, timeoutMs, describe, env: wanted }) {
    return new Promise((resolve, reject) => {
      const target = route(wanted.name);
      if (!target) {
        reject(unroutable(wanted));
        return;
      }
      const { connection, env } = target;
      const requestId = randomUUID();
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        log(`${describe} [${env.name}] timed out`);
        reject(new BridgeError('TIMEOUT', `The browser extension did not answer ${describe} within ${Math.round(timeoutMs / 1000)}s.`, { environment: env.name }));
      }, timeoutMs);
      const settle = (msg) => {
        const elapsed = Date.now() - startedAt;
        const failed = msg.error || msg.errorCode || (typeof msg.status === 'number' && msg.status >= 400);
        if (failed) {
          const error = errorFromResult(msg, env, describe);
          log(`${describe} [${env.name}] ${error.code}${error.status ? ` ${error.status}` : ''} ${elapsed}ms`);
          reject(error);
          return;
        }
        log(`${describe} [${env.name}] ${msg.status ?? 'ok'} ${elapsed}ms${msg.polls ? ` (${msg.polls} polls)` : ''}`);
        resolve({ status: typeof msg.status === 'number' ? msg.status : 200, data: msg.data, polls: typeof msg.polls === 'number' ? msg.polls : 0 });
      };
      pending.set(requestId, { connection, timer, settle, reject });
      lastUsed = connection;
      try {
        connection.socket.send(JSON.stringify({ ...frame, environment: env.name, requestId }));
      } catch (e) {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(new BridgeError('NO_EXTENSION', `Could not send the request to the browser extension: ${e.message}`));
      }
    });
  }

  async function dt(request, { environment = null, tool = null, label = null } = {}) {
    const wire = normalizeRequest(request);
    await waitForExtension();
    const env = resolveEnvironment(environment);
    const describe = `${wire.method} ${wire.path}`;
    const lane = laneFor(env, wire.path.startsWith('/rest/v2/') ? 'v2' : 'analysis');
    return lane(() => exchange({
      frame: { type: 'DT_REQUEST', environment: env.name, tool, label: label || describe, request: wire },
      timeoutMs: wire.timeoutMs + timeoutGraceMs,
      describe,
      env,
    }));
  }

  const updateAvailable = () => compareVersions(serverVersion, updates.latestVersion()) === -1;

  function extensionNote() {
    const connection = reportedConnection();
    if (!connection || connection.version === serverVersion) return null;
    if (compareVersions(connection.version, serverVersion) === 1) {
      return {
        kind: 'server-older',
        text: `Note: the ${EXTENSION_NAME} extension (${connection.version}) is newer than this MCP server (${serverVersion}). Tell the user to restart their MCP client (Claude Code, Cursor, …) so that it starts the current server version.`,
      };
    }
    if (compareVersions(connection.version, serverVersion) === 0) return null;
    return {
      kind: 'extension-outdated',
      text: `Note: the ${EXTENSION_NAME} extension is outdated (extension ${connection.version || 'unknown version'}, server ${serverVersion}). Tell the user to run \`npx -y ${PACKAGE_NAME}@latest install-extension\` and click reload on the extension in their browser's extensions page (chrome://extensions, brave://extensions, edge://extensions, …).`,
    };
  }

  function updateNotes() {
    const notes = [];
    const extension = extensionNote();
    if (extension) notes.push(extension);
    if (updateAvailable()) {
      notes.push({
        kind: 'server-update',
        text: `Note: ${PACKAGE_NAME} ${updates.latestVersion()} has been released and this server is ${serverVersion}. Tell the user to restart their MCP client (its \`npx -y ${PACKAGE_NAME}@latest\` command then starts the new version) and to update the browser extension when asked afterwards.`,
      });
    }
    return notes;
  }

  function status() {
    return {
      connected: connections.length > 0,
      ready: isReady(),
      extensionVersion: reportedConnection()?.version ?? null,
      environments: copyEnvironments(knownEnvironments()),
      host,
      port,
      connections: [...connections].reverse().map(c => ({
        id: c.id,
        ready: c.ready,
        version: c.version,
        connectedAt: c.connectedAt,
        environments: copyEnvironments(c.environments),
      })),
      latestVersion: updates.latestVersion(),
      updateAvailable: updateAvailable(),
    };
  }

  return {
    start,
    stop,
    dt,
    status,
    waitForExtension,
    findEnvironment,
    environments: () => copyEnvironments(knownEnvironments()),
    isConnected: () => connections.length > 0,
    extensionVersion: () => reportedConnection()?.version ?? null,
    serverVersion: () => serverVersion,
    updateNotes,
    checkForUpdate: () => updates.check(),
  };
}
