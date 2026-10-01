importScripts("allowlist.js");

const DEFAULT_WS_PORT = 47831;
const DEFAULT_TIMEOUT_MS = 90000;
const MAX_TIMEOUT_MS = 600000;
const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS = 20000;
const TAB_LOAD_TIMEOUT_MS = 15000;
const TAB_BOOT_DELAY_MS = 1000;
const INJECT_SETTLE_MS = 300;
const ACTIVITY_LIMIT = 12;
const LOGIN_FLOW_LIMIT_MS = 5 * 60 * 1000;
const SESSION_WAIT_MS = 3000;
const SESSION_CHECK_MS = 300;
const MAX_PROBED_TABS = 8;
const ENVIRONMENT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;
const ENVIRONMENT_BASE_PATH = /^\/e\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const BADGE_SCRIPT_ID = "dynatrace-bridge-badge";

let settings = { environments: [], wsPort: DEFAULT_WS_PORT };
let ws = null;
let wsConnected = false;
let pingTimer = null;
let reconnectTimer = null;
let pendingAdd = null;
let serverInfo = null;
let addQueue = Promise.resolve();
let badgeSync = Promise.resolve();
const activity = [];
const inflight = new Map();
const tabAcquisitions = new Map();
const loginTabs = new Map();

const settingsLoaded = loadSettings();
const loginTabsRestored = restoreLoginTabs();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

function log(color, text) {
  console.log(`%c[Dynatrace Bridge] %c${text}`, "color:#1496ff;font-weight:bold", `color:${color}`);
}

function cleanEnvironmentName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (ENVIRONMENT_NAME.test(name)) return name;
  const repaired = name.replace(/[^\p{L}\p{N} ._-]+/gu, "-").replace(/^[^\p{L}\p{N}]+/u, "").slice(0, 64).trim();
  return ENVIRONMENT_NAME.test(repaired) ? repaired : "";
}

function normalizeEnvironment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanEnvironmentName(raw.name);
  let origin = null;
  try {
    const url = new URL(raw.origin);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === raw.origin) origin = url.origin;
  } catch (error) {
    origin = null;
  }
  const base = typeof raw.basePath === "string" ? raw.basePath.match(ENVIRONMENT_BASE_PATH) : null;
  if (!name || !origin || !base) return null;
  return { name, envId: base[1], origin, basePath: raw.basePath };
}

function normalizeEnvironments(list) {
  return (Array.isArray(list) ? list : []).map(normalizeEnvironment).filter(Boolean);
}

function normalizePort(value) {
  const port = Number.parseInt(value, 10);
  return port >= 1 && port <= 65535 ? port : DEFAULT_WS_PORT;
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get({ environments: [], wsPort: DEFAULT_WS_PORT });
  settings = { environments: normalizeEnvironments(stored.environments), wsPort: normalizePort(stored.wsPort) };
}

const environmentBase = (env) => env.origin + env.basePath;
const environmentHome = (env) => `${environmentBase(env)}/`;
const sameEnvironment = (a, b) => a.origin === b.origin && a.basePath === b.basePath;

function originPattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

function environmentPatterns() {
  return [...new Set(settings.environments.map((env) => originPattern(env.origin)))];
}

function isEnvironmentUrl(url, env) {
  if (typeof url !== "string") return false;
  const base = environmentBase(env);
  return url === base || url.startsWith(`${base}/`);
}

function send(message) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function sendHello() {
  send({
    type: "HELLO",
    version: chrome.runtime.getManifest().version,
    environments: settings.environments.map(({ name, envId, origin, basePath }) => ({ name, envId, origin, basePath })),
  });
}

function parseVersion(value) {
  const match = typeof value === "string" ? value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function updateStatus() {
  const extensionVersion = chrome.runtime.getManifest().version;
  const serverVersion = wsConnected && serverInfo ? serverInfo.serverVersion : null;
  const latestVersion = wsConnected && serverInfo ? serverInfo.latestVersion : null;
  const order = compareVersions(extensionVersion, serverVersion);
  return {
    extensionVersion,
    serverVersion,
    latestVersion,
    extension: order === -1 ? "outdated" : order === 1 ? "newer" : null,
    serverUpdate: compareVersions(serverVersion, latestVersion) === -1,
  };
}

function acceptWelcome(message) {
  serverInfo = {
    serverVersion: typeof message.serverVersion === "string" ? message.serverVersion : null,
    latestVersion: typeof message.latestVersion === "string" ? message.latestVersion : null,
  };
  notifyBadges();
}

function lightStatus() {
  return { wsConnected, wsPort: settings.wsPort, environments: settings.environments, activity, update: updateStatus() };
}

async function notifyBadges() {
  try {
    const patterns = await grantedPatterns(environmentPatterns());
    if (patterns.length === 0) return;
    const status = lightStatus();
    for (const tab of await chrome.tabs.query({ url: patterns })) {
      chrome.tabs.sendMessage(tab.id, { type: "BADGE_STATUS", status }).catch(() => {});
    }
  } catch (error) {
    log("#9c9da4", `Could not update the pills: ${error.message}`);
  }
}

function updateActionBadge() {
  chrome.action.setBadgeBackgroundColor({ color: wsConnected ? "#73be28" : "#ef4444" });
  chrome.action.setBadgeText({ text: wsConnected ? "ON" : "OFF" });
}

function hasSiteAccess(env) {
  return chrome.permissions.contains({ origins: [originPattern(env.origin)] }).catch(() => false);
}

async function grantedPatterns(patterns) {
  const checks = await Promise.all(patterns.map((pattern) => chrome.permissions.contains({ origins: [pattern] }).catch(() => false)));
  return patterns.filter((pattern, index) => checks[index]);
}

async function registerBadgeScripts() {
  await settingsLoaded;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [BADGE_SCRIPT_ID] });
  } catch (error) {
    log("#9c9da4", "No pill registration to replace");
  }
  try {
    const matches = await grantedPatterns(environmentPatterns());
    if (matches.length === 0) return;
    await chrome.scripting.registerContentScripts([{ id: BADGE_SCRIPT_ID, matches, js: ["badge.js"], runAt: "document_idle" }]);
    for (const tab of await chrome.tabs.query({ url: matches })) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["badge.js"] }).catch(() => {});
    }
  } catch (error) {
    log("#ef4444", `Pill registration failed: ${error.message}`);
  }
}

function syncBadgeScripts() {
  badgeSync = badgeSync.then(registerBadgeScripts);
  return badgeSync;
}

function applyEnvironments(list) {
  settings.environments = normalizeEnvironments(list);
  sendHello();
  syncBadgeScripts();
  notifyBadges();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  settingsLoaded.then(() => {
    if (changes.environments) applyEnvironments(changes.environments.newValue);
    if (changes.wsPort) {
      const port = normalizePort(changes.wsPort.newValue);
      if (port !== settings.wsPort) {
        settings.wsPort = port;
        reconnect();
      }
    }
  });
});

chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "keepalive") return;
  if (!send({ type: "PING" })) connect();
});

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
}

function markDisconnected() {
  clearInterval(pingTimer);
  pingTimer = null;
  wsConnected = false;
  ws = null;
  serverInfo = null;
  updateActionBadge();
  notifyBadges();
}

function reconnect() {
  clearTimeout(reconnectTimer);
  const socket = ws;
  if (socket) {
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close();
    } catch (error) {
      log("#ef4444", `Could not close the old socket: ${error.message}`);
    }
    markDisconnected();
  }
  connect();
}

async function connect() {
  await settingsLoaded;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  clearTimeout(reconnectTimer);

  const socket = new WebSocket(`ws://localhost:${settings.wsPort}`);
  ws = socket;

  socket.onopen = () => {
    wsConnected = true;
    updateActionBadge();
    notifyBadges();
    log("#73be28", `Connected to the MCP server on port ${settings.wsPort}`);
    sendHello();
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: "PING" }), PING_INTERVAL_MS);
  };

  socket.onmessage = (event) => {
    let message = null;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      log("#ef4444", "Ignored a frame that is not JSON");
      return;
    }
    if (!message || message.type === "PONG") return;
    if (message.type === "WELCOME") acceptWelcome(message);
    if (message.type === "DT_REQUEST") handleDtRequest(message);
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    markDisconnected();
    log("#ef4444", "Disconnected from the MCP server, retrying in 3s");
    scheduleReconnect();
  };

  socket.onerror = () => {
    log("#ef4444", "WebSocket error. Is the MCP server running?");
  };
}

function resolveEnvironment(name) {
  const environments = settings.environments;
  if (environments.length === 0) {
    throw failure("NO_ENVIRONMENT", "No Dynatrace environment is configured. Open a Dynatrace environment page, click the Dynatrace Bridge extension icon and choose \"Add this environment\".");
  }
  if (name === null || name === undefined || name === "") return environments[0];
  const wanted = String(name).trim().toLowerCase();
  const env = environments.find((candidate) => candidate.name.toLowerCase() === wanted);
  if (!env) {
    throw failure("UNKNOWN_ENVIRONMENT", `Unknown environment "${name}". Configured environments: ${environments.map((e) => e.name).join(", ")}.`);
  }
  return env;
}

function openFlight(message, label) {
  const entry = {
    requestId: message.requestId,
    tool: typeof message.tool === "string" ? message.tool : null,
    label: String(label || "").slice(0, 200),
    environment: typeof message.environment === "string" ? message.environment : null,
    status: "running",
    time: new Date().toLocaleTimeString(),
    startedAt: Date.now(),
    durationMs: null,
    httpStatus: null,
    polls: null,
    error: null,
    errorCode: null,
  };
  activity.unshift(entry);
  if (activity.length > ACTIVITY_LIMIT) activity.length = ACTIVITY_LIMIT;
  const flight = {
    requestId: message.requestId,
    activity: entry,
    env: null,
    tabId: null,
    timer: null,
    delivered: false,
    recovered: false,
  };
  inflight.set(flight.requestId, flight);
  notifyBadges();
  return flight;
}

function settle(requestId, outcome) {
  const flight = inflight.get(requestId);
  if (!flight) return;
  inflight.delete(requestId);
  clearTimeout(flight.timer);
  const entry = flight.activity;
  entry.durationMs = Date.now() - entry.startedAt;
  entry.status = outcome.errorCode ? "error" : "done";
  entry.httpStatus = typeof outcome.status === "number" ? outcome.status : null;
  entry.polls = typeof outcome.polls === "number" ? outcome.polls : null;
  entry.errorCode = outcome.errorCode || null;
  entry.error = outcome.errorCode ? String(outcome.error || outcome.errorCode).slice(0, 300) : null;
  if (outcome.errorCode) log("#ef4444", `${entry.tool || "request"} failed (${outcome.errorCode}) after ${entry.durationMs} ms`);
  else log("#73be28", `${entry.tool || "request"} done in ${entry.durationMs} ms`);
  send({ type: "DT_RESULT", requestId, ...outcome });
  notifyBadges();
}

function fail(requestId, errorCode, error, status, loginTab) {
  settle(requestId, {
    error,
    errorCode,
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof loginTab === "string" ? { loginTab } : {}),
  });
}

function failWith(requestId, error) {
  fail(requestId, error?.code || "INTERNAL", error?.message || String(error), error?.status, error?.loginTab);
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab && typeof tab.windowId === "number") await chrome.windows.update(tab.windowId, { focused: true });
  } catch (error) {
    log("#ef4444", `Could not focus the tab: ${error.message}`);
  }
}

async function findEnvironmentTabs(env) {
  const tabs = await chrome.tabs.query({ url: originPattern(env.origin) });
  return tabs.filter((tab) => isEnvironmentUrl(tab.url, env));
}

function waitForTabComplete(tabId, timeoutMs, expectNavigation) {
  return new Promise((resolve) => {
    let sawLoading = !expectNavigation;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status === "complete" && sawLoading) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    if (!expectNavigation) {
      chrome.tabs.get(tabId).then((tab) => {
        if (tab?.status === "complete") finish();
      }, finish);
    }
  });
}

const LOGIN_MESSAGES = {
  opened: (env) => `Dynatrace needs a login for environment "${env.name}". A Dynatrace tab was opened and brought to the front, and it shows a login page; ask the user to log in to Dynatrace in that tab, then retry.`,
  waiting: (env) => `Dynatrace still needs a login for environment "${env.name}". The tab that was opened for it is still on a login page and was brought to the front again; ask the user to finish logging in to Dynatrace in that tab, then retry.`,
};

async function restoreLoginTabs() {
  try {
    const stored = await chrome.storage.session.get({ loginTabs: {} });
    for (const [key, entry] of Object.entries(stored.loginTabs || {})) {
      if (loginTabs.has(key) || typeof entry?.tabId !== "number" || typeof entry?.since !== "number") continue;
      loginTabs.set(key, { tabId: entry.tabId, since: entry.since });
    }
  } catch (error) {
    log("#ef4444", `Could not restore the login tabs: ${error.message}`);
  }
}

function persistLoginTabs() {
  chrome.storage.session.set({ loginTabs: Object.fromEntries(loginTabs) }).catch(() => {});
}

function trackLoginTab(env, tabId) {
  loginTabs.set(environmentBase(env), { tabId, since: Date.now() });
  persistLoginTabs();
}

function forgetLoginTab(env) {
  if (loginTabs.delete(environmentBase(env))) persistLoginTabs();
}

function sessionExpired(env, loginTab) {
  return failure("SESSION_EXPIRED", LOGIN_MESSAGES[loginTab](env), { loginTab });
}

async function getTab(tabId) {
  try {
    return (await chrome.tabs.get(tabId)) || null;
  } catch (error) {
    return null;
  }
}

async function settledTab(tabId) {
  let tab = await getTab(tabId);
  if (tab && tab.status !== "complete") {
    await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS, false);
    tab = await getTab(tabId);
  }
  return tab;
}

async function hasSession(tabId) {
  return (await detectOnTab(tabId))?.loggedIn === true;
}

async function awaitSession(tabId) {
  const deadline = Date.now() + SESSION_WAIT_MS;
  for (;;) {
    if (await hasSession(tabId)) return true;
    if (Date.now() + SESSION_CHECK_MS >= deadline) return false;
    await delay(SESSION_CHECK_MS);
  }
}

async function usableTab(tabId, env) {
  const tab = await settledTab(tabId);
  if (!tab || !isEnvironmentUrl(tab.url, env)) return null;
  return (await hasSession(tab.id)) ? tab : null;
}

async function requireEnvironmentTab(tabId, env) {
  const tab = await getTab(tabId);
  if (!tab) throw failure("NO_TAB", `The Dynatrace tab for environment "${env.name}" was closed before the request could run. Retry.`);
  if (!isEnvironmentUrl(tab.url, env)) {
    throw failure("NO_TAB", `The Dynatrace tab for environment "${env.name}" left the environment before the request could run. Retry: the extension then uses another Dynatrace tab or opens a new one.`);
  }
  return tab;
}

function isOnOrigin(tab, env) {
  try {
    return new URL(tab.url).origin === env.origin;
  } catch (error) {
    return false;
  }
}

async function checkLoginTab(env, state) {
  const entry = loginTabs.get(environmentBase(env));
  if (!entry) return null;
  const tab = await settledTab(entry.tabId);
  if (!tab) {
    forgetLoginTab(env);
    return null;
  }
  const inEnvironment = isEnvironmentUrl(tab.url, env);
  if (inEnvironment && (await awaitSession(tab.id))) {
    forgetLoginTab(env);
    return tab;
  }
  if (!inEnvironment && isOnOrigin(tab, env)) {
    if (await hasSession(tab.id)) {
      forgetLoginTab(env);
      return null;
    }
    entry.since = Date.now();
    persistLoginTabs();
  } else if (Date.now() - entry.since > LOGIN_FLOW_LIMIT_MS) {
    forgetLoginTab(env);
    return null;
  }
  await focusTab(tab.id);
  throw sessionExpired(env, state);
}

async function lastNormalWindowId() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    return win?.type === "normal" && typeof win.id === "number" ? win.id : null;
  } catch (error) {
    return null;
  }
}

async function createVisibleTab(url) {
  const windowId = await lastNormalWindowId();
  if (windowId !== null) {
    const tab = await chrome.tabs.create({ url, active: true, windowId });
    await chrome.windows.update(windowId, { focused: true });
    return tab;
  }
  const created = await chrome.windows.create({ url, focused: true, type: "normal" });
  return created.tabs[0];
}

async function openEnvironmentTab(env) {
  log("#00a1b2", `No usable Dynatrace tab for "${env.name}", opening one in front`);
  let tab = null;
  try {
    tab = await createVisibleTab(environmentHome(env));
  } catch (error) {
    throw failure("NO_TAB", `Could not open ${environmentHome(env)}: ${error.message}`);
  }
  trackLoginTab(env, tab.id);
  await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS, false);
  await delay(TAB_BOOT_DELAY_MS);
  const ready = await checkLoginTab(env, "opened");
  if (ready) return ready;
  throw failure("NO_TAB", `Opening ${environmentHome(env)} did not lead to environment "${env.name}": the tab was closed or shows another Dynatrace page. Check that the environment still exists and that the user has access to it.`);
}

async function wakeTab(tabId, env) {
  const loaded = waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS, true);
  try {
    await chrome.tabs.reload(tabId);
  } catch (error) {
    return null;
  }
  await loaded;
  await delay(TAB_BOOT_DELAY_MS);
  return usableTab(tabId, env);
}

async function locateTab(env) {
  await loginTabsRestored;
  const tracked = loginTabs.get(environmentBase(env))?.tabId;
  const tabs = (await findEnvironmentTabs(env)).filter((tab) => tab.id !== tracked);
  const awake = tabs.filter((tab) => !tab.discarded);
  const candidates = [...awake.filter((tab) => tab.status === "complete"), ...awake.filter((tab) => tab.status !== "complete")];
  for (const candidate of candidates.slice(0, MAX_PROBED_TABS)) {
    const tab = await usableTab(candidate.id, env);
    if (tab) {
      forgetLoginTab(env);
      return tab;
    }
  }
  const signedIn = await checkLoginTab(env, "waiting");
  if (signedIn) return signedIn;
  const asleep = tabs.find((tab) => tab.discarded);
  return (asleep ? await wakeTab(asleep.id, env) : null) || openEnvironmentTab(env);
}

function acquireTab(env) {
  const key = environmentBase(env);
  const running = tabAcquisitions.get(key);
  if (running) return running;
  const acquisition = locateTab(env).finally(() => tabAcquisitions.delete(key));
  tabAcquisitions.set(key, acquisition);
  return acquisition;
}

function postToTab(tabId, payload) {
  return chrome.tabs.sendMessage(tabId, payload).then((reply) => reply?.ok === true, () => false);
}

async function injectScripts(tabId, env) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["allowlist.js", "inject.js"], world: "MAIN" });
  } catch (error) {
    await requireEnvironmentTab(tabId, env);
    throw failure("NO_TAB", `Could not inject the bridge into the Dynatrace tab for "${env.name}": ${error.message}. Check that the extension still has access to ${env.origin} (remove and re-add the environment in the popup).`);
  }
}

async function deliver(flight) {
  const payload = {
    type: "DT_REQUEST",
    requestId: flight.requestId,
    request: flight.request,
    basePath: flight.env.basePath,
    deadlineAt: flight.deadlineAt,
  };
  if (await postToTab(flight.tabId, payload)) {
    flight.delivered = true;
    return;
  }
  if (!inflight.has(flight.requestId)) return;
  log("#00a1b2", "Page bridge not present, injecting");
  await injectScripts(flight.tabId, flight.env);
  await delay(INJECT_SETTLE_MS);
  if (!inflight.has(flight.requestId)) return;
  if (await postToTab(flight.tabId, payload)) {
    flight.delivered = true;
    return;
  }
  await requireEnvironmentTab(flight.tabId, flight.env);
  throw failure("NO_TAB", `The Dynatrace tab for "${flight.env.name}" did not respond after injecting the bridge. Reload the tab and retry.`);
}

function clampTimeout(value) {
  const timeout = Number(value);
  if (!(timeout > 0)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.round(timeout), MAX_TIMEOUT_MS);
}

async function handleDtRequest(message) {
  if (typeof message.requestId !== "string" || inflight.has(message.requestId)) return;
  const request = message.request && typeof message.request === "object" ? message.request : {};
  const timeoutMs = clampTimeout(request.timeoutMs);
  const flight = openFlight(message, message.label || `${request.method} ${request.path}`);
  const requestId = flight.requestId;
  flight.request = {
    method: request.method,
    path: request.path,
    query: request.query && typeof request.query === "object" ? request.query : {},
    poll: request.poll === true,
    timeoutMs,
    ...(typeof request.maxBytes === "number" ? { maxBytes: request.maxBytes } : {}),
  };
  flight.deadlineAt = Date.now() + timeoutMs - Math.min(1000, Math.round(timeoutMs / 4));
  flight.timer = setTimeout(() => {
    fail(requestId, "TIMEOUT", `The Dynatrace tab did not answer within ${timeoutMs} ms.`);
  }, timeoutMs);
  log("#00a1b2", `${flight.activity.tool || "request"}: ${flight.activity.label}`);

  try {
    await settingsLoaded;
    const env = resolveEnvironment(message.environment);
    flight.env = env;
    flight.activity.environment = env.name;
    const verdict = globalThis.DT_ALLOWLIST.check(flight.request.method, flight.request.path);
    if (!verdict.allowed) throw failure("BLOCKED", `Blocked by the read-only allow-list: ${verdict.reason}`);
    if (!(await hasSiteAccess(env))) {
      throw failure("NO_TAB", `The extension has no site access to ${env.origin} any more. Ask the user to open the Dynatrace Bridge popup on a Dynatrace tab of environment "${env.name}", remove the environment and add it again.`);
    }
    const tab = await acquireTab(env);
    if (!inflight.has(requestId)) return;
    flight.tabId = tab.id;
    await deliver(flight);
  } catch (error) {
    failWith(requestId, error);
  }
}

async function redeliver(flight) {
  try {
    await requireEnvironmentTab(flight.tabId, flight.env);
    flight.delivered = false;
    await deliver(flight);
  } catch (error) {
    failWith(flight.requestId, error);
  }
}

async function recoverFlights(tabId) {
  const candidates = [...inflight.values()].filter((flight) => flight.tabId === tabId && flight.delivered);
  if (candidates.length === 0) return;
  const probe = await chrome.tabs.sendMessage(tabId, { type: "DT_PROBE" }).catch(() => null);
  const alive = new Set(probe?.ok ? probe.inflight : []);
  for (const flight of candidates) {
    if (!inflight.has(flight.requestId) || alive.has(flight.requestId) || !flight.delivered) continue;
    if (flight.recovered) {
      fail(flight.requestId, "NO_TAB", `The Dynatrace tab for "${flight.env.name}" navigated away twice while the request was running.`);
      continue;
    }
    flight.recovered = true;
    log("#00a1b2", "The page was reloaded during a request, sending it again");
    redeliver(flight);
  }
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete") recoverFlights(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const flight of [...inflight.values()]) {
    if (flight.tabId !== tabId) continue;
    fail(flight.requestId, "NO_TAB", "The Dynatrace tab was closed while the request was running.");
  }
  loginTabsRestored.then(() => {
    const keys = [...loginTabs].filter(([, entry]) => entry.tabId === tabId).map(([key]) => key);
    for (const key of keys) loginTabs.delete(key);
    if (keys.length > 0) persistLoginTabs();
  });
});

function detectEnvironment() {
  const match = window.location.pathname.match(/^\/e\/([^/]+)/);
  return {
    origin: window.location.origin,
    envId: match ? match[1] : null,
    basePath: match ? match[0] : null,
    loggedIn: typeof window.csrf_token === "string" && window.csrf_token !== "",
  };
}

async function detectOnTab(tabId) {
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: detectEnvironment });
    return injection?.result || null;
  } catch (error) {
    return null;
  }
}

function slugify(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function defaultEnvironmentName(envId, origin) {
  const parts = String(envId || "").split("-").filter(Boolean);
  const last = parts[parts.length - 1] || "";
  if (parts.length > 1 && /^[a-z0-9]{1,8}$/i.test(last)) return last.toLowerCase();
  if (envId && envId.length <= 12 && slugify(envId)) return slugify(envId);
  return slugify(new URL(origin).hostname.split(".")[0]) || "dynatrace";
}

function uniqueEnvironmentName(base, environments) {
  const taken = new Set(environments.map((env) => env.name.toLowerCase()));
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }
}

async function describeTab(tabId) {
  await settingsLoaded;
  const detected = await detectOnTab(tabId);
  if (!detected) return { readable: false };
  const existing = detected.basePath ? settings.environments.find((env) => sameEnvironment(env, detected)) : null;
  return {
    readable: true,
    isDynatrace: Boolean(detected.envId),
    loggedIn: detected.loggedIn,
    origin: detected.origin,
    envId: detected.envId,
    basePath: detected.basePath,
    existingName: existing ? existing.name : null,
    suggestedName: detected.envId ? uniqueEnvironmentName(defaultEnvironmentName(detected.envId, detected.origin), settings.environments) : null,
  };
}

async function addEnvironmentNow({ tabId }) {
  await settingsLoaded;
  const detected = await detectOnTab(tabId);
  if (!detected || !detected.envId) throw new Error(chrome.i18n.getMessage("notDynatracePage"));
  if (!detected.loggedIn) throw new Error(chrome.i18n.getMessage("notLoggedIn"));
  const environments = settings.environments.map(({ name, envId, origin, basePath }) => ({ name, envId, origin, basePath }));
  const existing = environments.find((env) => sameEnvironment(env, detected));
  if (existing) return { name: existing.name, envId: existing.envId };
  const name = uniqueEnvironmentName(defaultEnvironmentName(detected.envId, detected.origin), environments);
  const added = normalizeEnvironment({ name, origin: detected.origin, basePath: detected.basePath });
  if (!added) throw new Error(chrome.i18n.getMessage("notDynatracePage"));
  environments.push(added);
  settings.environments = environments;
  await chrome.storage.sync.set({ environments });
  log("#73be28", `Added environment "${name}"`);
  return { name, envId: detected.envId };
}

function addEnvironment(request) {
  const run = addQueue.then(() => addEnvironmentNow(request));
  addQueue = run.catch(() => {});
  return run;
}

chrome.permissions.onAdded.addListener((permissions) => {
  const pending = pendingAdd;
  if (!pending || !(permissions.origins || []).includes(pending.pattern)) return;
  pendingAdd = null;
  addEnvironment(pending).catch((error) => log("#ef4444", `Adding the environment failed: ${error.message}`));
});

async function fullStatus() {
  await settingsLoaded;
  const environments = await Promise.all(settings.environments.map(async (env) => {
    let tabCount = 0;
    let permitted = false;
    try {
      tabCount = (await findEnvironmentTabs(env)).length;
      permitted = await chrome.permissions.contains({ origins: [originPattern(env.origin)] });
    } catch (error) {
      tabCount = 0;
    }
    return { ...env, tabCount, permitted };
  }));
  return {
    wsConnected,
    wsPort: settings.wsPort,
    version: chrome.runtime.getManifest().version,
    environments,
    activity,
    update: updateStatus(),
  };
}

function acceptResult(message, sender) {
  const flight = inflight.get(message.requestId);
  if (!flight || sender.tab?.id !== flight.tabId) return;
  if (!message.errorCode) {
    settle(flight.requestId, { status: message.status, data: message.data, polls: message.polls || 0 });
    return;
  }
  if (message.errorCode !== "SESSION_EXPIRED") {
    fail(flight.requestId, message.errorCode, message.error, message.status);
    return;
  }
  focusTab(flight.tabId);
  fail(flight.requestId, "SESSION_EXPIRED", `${message.error} The tab has been focused; ask the user to log in to Dynatrace there (environment "${flight.env.name}"), then retry.`, message.status);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "DT_RESULT") {
    acceptResult(message, sender);
    return false;
  }
  if (message.type === "GET_STATUS" && message.light) {
    settingsLoaded.then(() => sendResponse(lightStatus()));
    return true;
  }
  if (message.type === "GET_STATUS") {
    fullStatus().then(sendResponse);
    return true;
  }
  if (message.type === "PEEK_ENVIRONMENT") {
    describeTab(message.tabId).then(sendResponse, () => sendResponse({ readable: false }));
    return true;
  }
  if (message.type === "PREPARE_ADD_ENVIRONMENT") {
    pendingAdd = { tabId: message.tabId, pattern: message.pattern };
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "CANCEL_ADD_ENVIRONMENT") {
    if (pendingAdd?.pattern === message.pattern) pendingAdd = null;
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "ADD_ENVIRONMENT") {
    if (pendingAdd?.pattern === message.pattern) pendingAdd = null;
    addEnvironment(message).then(sendResponse, (error) => sendResponse({ error: error.message }));
    return true;
  }
  return false;
});

updateActionBadge();
connect();
syncBadgeScripts();
