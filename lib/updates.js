import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const PACKAGE_NAME = 'dynatrace-bridge-mcp';
export const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 5000;

export function parseVersion(value) {
  const match = typeof value === 'string' ? value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function packageVersion() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

export function updateCheckEnabled(env = process.env) {
  const flag = String(env.DT_BRIDGE_UPDATE_CHECK ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false') return false;
  return true;
}

export function createUpdateChecker({
  url = REGISTRY_URL,
  enabled = true,
  fetchImpl = globalThis.fetch,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
  onChange = () => {},
  log = () => {},
} = {}) {
  let latest = null;
  let timer = null;
  let running = null;
  let checks = 0;

  async function fetchLatest() {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      await response.body?.cancel?.();
      return null;
    }
    const version = (await response.json())?.version;
    return parseVersion(version) ? version.trim() : null;
  }

  function check() {
    if (!enabled) return Promise.resolve(latest);
    if (running) return running;
    checks++;
    running = fetchLatest()
      .then((version) => {
        if (!version || version === latest) return;
        latest = version;
        log(`Latest published version: ${latest}`);
        onChange(latest);
      })
      .catch(() => {})
      .then(() => {
        running = null;
        return latest;
      });
    return running;
  }

  function start() {
    if (!enabled || timer) return;
    check();
    timer = setInterval(check, intervalMs);
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, check, enabled, latestVersion: () => latest, checks: () => checks };
}
