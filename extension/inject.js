(() => {
  const generation = (Number(window.__dynatraceBridgeInjectGeneration) || 0) + 1;
  window.__dynatraceBridgeInjectGeneration = generation;
  const isCurrent = () => window.__dynatraceBridgeInjectGeneration === generation;

  const CONTENT_SOURCE = "dynatrace-bridge-content";
  const INJECT_SOURCE = "dynatrace-bridge-inject";
  const POLL_INTERVAL_MS = 800;
  const DEFAULT_TIMEOUT_MS = 90000;
  const TOKEN_CHECK_MS = 100;
  const TOKEN_MAX_WAIT_MS = 5000;
  const EXCERPT_LENGTH = 300;
  const MEBIBYTE = 1024 * 1024;
  const DEFAULT_MAX_BYTES = 32 * MEBIBYTE;
  const MAX_BYTES_CEILING = 48 * MEBIBYTE;
  const SIZE_ADVICE = "Use a shorter time window or narrower filters.";
  const CSRF_REJECTED = 499;

  const inflight = new Set();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const failure = (errorCode, error, status) => (status === undefined ? { errorCode, error } : { errorCode, error, status });
  const excerpt = (text) => String(text || "").replace(/\s+/g, " ").trim().slice(0, EXCERPT_LENGTH);
  const currentToken = () => (typeof window.csrf_token === "string" && window.csrf_token ? window.csrf_token : null);

  function post(message) {
    window.postMessage({ ...message, source: INJECT_SOURCE }, window.location.origin);
  }

  async function waitForToken(deadlineAt) {
    const startedAt = Date.now();
    for (;;) {
      const token = currentToken();
      if (token) return token;
      if (document.readyState === "complete") return null;
      if (Date.now() - startedAt >= TOKEN_MAX_WAIT_MS) return null;
      if (Date.now() + TOKEN_CHECK_MS >= deadlineAt) return null;
      await sleep(TOKEN_CHECK_MS);
    }
  }

  function buildParams(query) {
    const params = new URLSearchParams();
    if (!query || typeof query !== "object") return params;
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item === null || item === undefined) continue;
        params.append(key, String(item));
      }
    }
    return params;
  }

  function buildUrl(basePath, path, params) {
    const search = params.toString();
    const url = new URL(window.location.origin + basePath + path + (search ? `?${search}` : ""));
    if (url.origin !== window.location.origin || url.pathname !== basePath + path) return null;
    return url.href;
  }

  function pageMatchesBasePath(basePath) {
    const pathname = window.location.pathname;
    return basePath === "" || pathname === basePath || pathname.startsWith(`${basePath}/`);
  }

  function leftRest(response, restPrefix) {
    if (!response.redirected) return false;
    try {
      const final = new URL(response.url);
      return final.origin !== window.location.origin || !final.pathname.startsWith(restPrefix);
    } catch (error) {
      return true;
    }
  }

  function isJsonAnswer(response, text) {
    if (!/\bjson\b/i.test(response.headers?.get?.("content-type") || "")) return false;
    if (typeof text !== "string") return false;
    try {
      JSON.parse(text);
      return true;
    } catch (error) {
      return false;
    }
  }

  function parseBody(text) {
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      return text;
    }
  }

  function clampMaxBytes(value) {
    if (typeof value !== "number" || !(value >= 1)) return DEFAULT_MAX_BYTES;
    return Math.min(Math.floor(value), MAX_BYTES_CEILING);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < MEBIBYTE) return `${(bytes / 1024).toFixed(1)} kB`;
    return `${(bytes / MEBIBYTE).toFixed(1)} MB`;
  }

  function tooLargeMessage(tooLarge, maxBytes) {
    const reached = tooLarge.declared
      ? `Dynatrace announced ${formatSize(tooLarge.bytes)}`
      : `reading stopped at ${formatSize(tooLarge.bytes)}`;
    return `Response too large: ${reached}, the limit is ${formatSize(maxBytes)}. ${SIZE_ADVICE}`;
  }

  async function discard(response) {
    try {
      await response.body?.cancel();
    } catch (error) {
      return;
    }
  }

  async function readBody(response, maxBytes) {
    const header = response.headers?.get?.("content-length");
    const declared = header === null || header === undefined || header === "" ? NaN : Number(header);
    if (declared > maxBytes) {
      await discard(response);
      return { tooLarge: { bytes: declared, declared: true } };
    }
    if (!response.body) {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) return { tooLarge: { bytes: buffer.byteLength, declared: false } };
      return { text: new TextDecoder().decode(buffer) };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        reader.cancel().catch(() => {});
        return { tooLarge: { bytes: received, declared: false } };
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return { text: parts.join("") };
  }

  async function send(url, token, redirect, deadlineAt, maxBytes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { "X-CSRFToken": token, Accept: "application/json; charset=utf-8" },
        credentials: "same-origin",
        cache: "no-store",
        redirect,
        signal: controller.signal,
      });
      if (response.type === "opaqueredirect") return { response, redirected: true };
      return { response, ...(await readBody(response, maxBytes)) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchOnce(url, restPrefix, deadlineAt, maxBytes) {
    const token = currentToken();
    if (!token) return { sessionExpired: true };
    const direct = await send(url, token, "manual", deadlineAt, maxBytes);
    if (!direct.redirected) return { ...direct, token };
    let followed = null;
    try {
      followed = await send(url, token, "follow", deadlineAt, maxBytes);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return { sessionExpired: true };
    }
    if (leftRest(followed.response, restPrefix) && !isJsonAnswer(followed.response, followed.text)) return { sessionExpired: true };
    return { ...followed, token };
  }

  const SESSION_MESSAGE = "The Dynatrace session in this tab has expired or the user is not logged in.";

  async function execute(message) {
    const request = message.request || {};
    const method = request.method;
    const path = request.path;
    const basePath = typeof message.basePath === "string" ? message.basePath : null;
    const timeoutMs = Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const deadlineAt = Number.isFinite(message.deadlineAt) ? message.deadlineAt : Date.now() + timeoutMs;
    const maxBytes = clampMaxBytes(request.maxBytes);

    const verdict = globalThis.DT_ALLOWLIST
      ? globalThis.DT_ALLOWLIST.check(method, path)
      : { allowed: false, reason: "allow-list is not loaded in the page" };
    if (!verdict.allowed) return failure("BLOCKED", `Blocked by the read-only allow-list: ${verdict.reason}`);

    if (basePath === null) return failure("INTERNAL", "The request did not carry the environment base path.");
    if (!pageMatchesBasePath(basePath)) {
      return failure("NO_TAB", "The tab is no longer on this Dynatrace environment.");
    }

    if (!(await waitForToken(deadlineAt))) return failure("SESSION_EXPIRED", SESSION_MESSAGE);

    const params = buildParams(request.query);
    const restPrefix = `${basePath}/rest/`;
    let polls = 0;
    let tokenRefreshed = false;

    for (;;) {
      const url = buildUrl(basePath, path, params);
      if (!url) return failure("BLOCKED", "Blocked by the read-only allow-list: the path is not in canonical form.");

      let outcome;
      try {
        outcome = await fetchOnce(url, restPrefix, deadlineAt, maxBytes);
      } catch (error) {
        if (error?.name === "AbortError") {
          return polls > 0
            ? failure("POLL_TIMEOUT", `Dynatrace was still computing after ${polls} polls and ${timeoutMs} ms.`)
            : failure("TIMEOUT", `Dynatrace did not answer within ${timeoutMs} ms.`);
        }
        return failure("INTERNAL", `Request to Dynatrace failed: ${error?.message || String(error)}`);
      }
      if (outcome.sessionExpired) return failure("SESSION_EXPIRED", SESSION_MESSAGE);

      const { response, text } = outcome;
      const status = response.status;

      if (outcome.tooLarge) return failure("RESPONSE_TOO_LARGE", tooLargeMessage(outcome.tooLarge, maxBytes), status);

      if (status === 401) return failure("SESSION_EXPIRED", SESSION_MESSAGE, status);
      if (status === CSRF_REJECTED) {
        const fresh = currentToken();
        if (!fresh) return failure("SESSION_EXPIRED", SESSION_MESSAGE, status);
        if (fresh !== outcome.token) {
          if (tokenRefreshed) return failure("SESSION_EXPIRED", SESSION_MESSAGE, status);
          tokenRefreshed = true;
          continue;
        }
      }

      if (status === 202 && request.poll) {
        const progress = parseBody(text);
        const progressToken = progress && typeof progress === "object" ? progress.token : null;
        if (progressToken !== null && progressToken !== undefined && progressToken !== "") {
          if (Date.now() + POLL_INTERVAL_MS >= deadlineAt) {
            return failure("POLL_TIMEOUT", `Dynatrace was still computing after ${polls + 1} polls and ${timeoutMs} ms.`, status);
          }
          params.set("prgtkn", String(progressToken));
          polls += 1;
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
      }

      if (status >= 200 && status < 300) return { status, data: parseBody(text), polls };

      const statusText = response.statusText ? ` ${response.statusText}` : "";
      const body = excerpt(text);
      return failure("HTTP_ERROR", `HTTP ${status}${statusText}${body ? `: ${body}` : ""}`, status);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== CONTENT_SOURCE || !isCurrent()) return;

    if (message.type === "DT_PROBE") {
      post({ type: "DT_PROBE_RESULT", probeId: message.probeId, inflight: [...inflight] });
      return;
    }
    if (message.type !== "DT_REQUEST" || typeof message.requestId !== "string") return;

    const requestId = message.requestId;
    post({ type: "DT_ACK", requestId });
    if (inflight.has(requestId)) return;
    inflight.add(requestId);

    execute(message)
      .catch((error) => failure("INTERNAL", `Unexpected error in the page bridge: ${error?.message || String(error)}`))
      .then((result) => {
        inflight.delete(requestId);
        post({ type: "DT_RESULT", requestId, ...result });
      });
  });
})();
