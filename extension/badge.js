(() => {
  if (window.top !== window) return;

  const isAlive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (error) {
      return false;
    }
  };

  if (window.__dynatraceBridgeBadge?.isAlive?.()) return;
  window.__dynatraceBridgeBadge = { isAlive };

  const HOST_ID = "dynatrace-bridge-pill";
  const POLL_INTERVAL_MS = 3000;
  const LABEL_LIMIT = 70;

  const STYLE = `
    :host {
      all: initial; position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
      --surface: #242424;
      --surface-hover: #38393b;
      --border: #4a4b4f;
      --track: #4a4b4f;
      --text: #f2f2f4;
      --text-muted: #b4b5bb;
      --focus: #5cb6ff;
      --green: #73be28;
      --green-text: #8ad23f;
      --teal-text: #2ec6d6;
      --red: #ef4444;
      --red-text: #ff7b7b;
      --amber: #f5a623;
      --amber-glow: rgba(245, 166, 35, 0.5);
      --green-glow: rgba(115, 190, 40, 0.55);
      --teal-glow: rgba(46, 198, 214, 0.55);
      --red-glow: rgba(239, 68, 68, 0.55);
      --shadow: rgba(0, 0, 0, 0.4);
    }
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      height: 24px; box-sizing: border-box; padding: 0 10px 0 4px; border-radius: 999px;
      max-width: min(480px, calc(100vw - 32px));
      font: 600 11px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text); background: var(--surface); border: 1px solid var(--border);
      box-shadow: 0 2px 8px var(--shadow);
      white-space: nowrap; cursor: default; opacity: 0.96;
    }
    .pill:hover { opacity: 1; }
    .toggle {
      all: unset; display: inline-flex; align-items: center; justify-content: center;
      width: 16px; height: 16px; border-radius: 50%; cursor: pointer; flex: none;
    }
    .toggle:hover { background: var(--surface-hover); }
    .toggle:focus-visible { outline: 1px solid var(--focus); }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--red); box-shadow: 0 0 5px var(--red-glow); }
    .pill.ok .dot { background: var(--green); box-shadow: 0 0 5px var(--green-glow); }
    .pill.busy .dot { background: var(--teal-text); box-shadow: 0 0 5px var(--teal-glow); animation: pulse 1s ease-in-out infinite; }
    .pill.err .dot { background: var(--red); box-shadow: 0 0 5px var(--red-glow); }
    .pill.warn .dot { background: var(--amber); box-shadow: 0 0 5px var(--amber-glow); }
    .spin {
      display: none; width: 9px; height: 9px; box-sizing: border-box; flex: none;
      border: 2px solid var(--track); border-top-color: var(--teal-text); border-radius: 50%;
      animation: rotate 0.8s linear infinite;
    }
    .pill.busy .spin { display: inline-block; }
    .text { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted); font-weight: 500; }
    .code { flex: none; display: none; color: var(--red-text); font-weight: 600; }
    .pill.ok .text { color: var(--green-text); }
    .pill.busy .text { color: var(--teal-text); }
    .pill.err .text { color: var(--red-text); }
    .pill.err .code { display: inline; }
    .pill.warn .text { color: var(--amber); }
    .pill.collapsed { padding: 0 4px; gap: 0; }
    .pill.collapsed .text, .pill.collapsed .spin, .pill.collapsed .code { display: none; }
    @keyframes pulse { 50% { opacity: 0.3; } }
    @keyframes rotate { to { transform: rotate(360deg); } }
  `;

  let host = null;
  let pill = null;
  let textEl = null;
  let codeEl = null;
  let toggleEl = null;
  let collapsed = false;
  let lastStatus = null;
  let pollTimer = null;

  const msg = (key, ...subs) => {
    try {
      return chrome.i18n.getMessage(key, subs.map(String)) || key;
    } catch (error) {
      return key;
    }
  };

  function currentEnvironment(status) {
    return (status.environments || []).find((env) => {
      const base = env.origin + env.basePath;
      return window.location.href === base || window.location.href.startsWith(`${base}/`);
    }) || null;
  }

  function attachStyle(root) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
      root.adoptedStyleSheets = [sheet];
    } catch (error) {
      const style = document.createElement("style");
      style.textContent = STYLE;
      root.appendChild(style);
    }
  }

  function applyCollapsed() {
    if (!pill) return;
    pill.classList.toggle("collapsed", collapsed);
    toggleEl.title = collapsed ? msg("badgeExpand") : msg("badgeCollapse");
    toggleEl.setAttribute("aria-label", toggleEl.title);
  }

  function toggleCollapsed() {
    collapsed = !collapsed;
    applyCollapsed();
    try {
      chrome.storage.local.set({ badgeCollapsed: collapsed });
    } catch (error) {
      shutdown();
    }
  }

  function ensurePill() {
    if (host && host.isConnected) return;
    document.getElementById(HOST_ID)?.remove();
    host = document.createElement("div");
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: "open" });
    attachStyle(root);
    pill = document.createElement("div");
    pill.className = "pill";
    pill.lang = msg("@@ui_locale").replace("_", "-");
    toggleEl = document.createElement("button");
    toggleEl.className = "toggle";
    toggleEl.type = "button";
    const dot = document.createElement("span");
    dot.className = "dot";
    toggleEl.appendChild(dot);
    toggleEl.addEventListener("click", toggleCollapsed);
    const spin = document.createElement("span");
    spin.className = "spin";
    textEl = document.createElement("span");
    textEl.className = "text";
    codeEl = document.createElement("span");
    codeEl.className = "code";
    pill.append(toggleEl, spin, textEl, codeEl);
    root.appendChild(pill);
    document.documentElement.appendChild(host);
    applyCollapsed();
  }

  function removePill() {
    host?.remove();
    host = null;
    pill = null;
  }

  function describe(entry) {
    const label = entry.label && entry.label.length > LABEL_LIMIT ? `${entry.label.slice(0, LABEL_LIMIT)}…` : entry.label;
    const tool = entry.tool || msg("activityRequestTool");
    return label ? `${tool} · ${label}` : tool;
  }

  function outcome(entry) {
    return entry.httpStatus === null ? msg("activityDone") : msg("activityHttp", entry.httpStatus);
  }

  function updateNotice(update) {
    if (!update) return null;
    if (update.extension === "outdated") {
      return { text: msg("badgeExtensionOutdated"), title: msg("badgeExtensionOutdatedTitle", update.serverVersion, update.extensionVersion) };
    }
    if (update.extension === "newer") {
      return { text: msg("badgeServerRestart"), title: msg("badgeServerRestartTitle", update.serverVersion, update.extensionVersion) };
    }
    if (update.serverUpdate) {
      return { text: msg("badgeServerUpdate"), title: msg("badgeServerUpdateTitle", update.latestVersion, update.serverVersion) };
    }
    return null;
  }

  function render(status) {
    if (!status) return;
    lastStatus = status;
    const env = currentEnvironment(status);
    if (!env) {
      removePill();
      return;
    }
    ensurePill();
    const mine = (status.activity || []).filter((entry) => entry.environment && entry.environment.toLowerCase() === env.name.toLowerCase());
    const running = mine.filter((entry) => entry.status === "running");
    const latest = mine[0] || null;
    const connected = Boolean(status.wsConnected);
    const busy = connected && running.length > 0;
    const failed = connected && !busy && latest?.status === "error";
    const notice = connected && !busy && !failed ? updateNotice(status.update) : null;

    pill.classList.toggle("ok", connected && !busy && !failed && !notice);
    pill.classList.toggle("busy", busy);
    pill.classList.toggle("err", failed);
    pill.classList.toggle("warn", Boolean(notice));
    codeEl.textContent = failed && latest.errorCode ? `· ${latest.errorCode}` : "";

    if (!connected) {
      textEl.textContent = msg("badgeNoServer");
      pill.title = msg("badgeNoServerTitle");
    } else if (busy) {
      const what = describe(running[0]);
      textEl.textContent = running.length > 1 ? msg("badgeBusyMore", what, running.length - 1) : msg("badgeBusy", what);
      pill.title = msg("badgeBusyTitle", what, running[0].time);
    } else if (failed) {
      const what = describe(latest);
      textEl.textContent = msg("badgeFailed", what);
      pill.title = msg("badgeFailedTitle", what, latest.time, latest.error || latest.errorCode || "");
    } else if (notice) {
      textEl.textContent = notice.text;
      pill.title = notice.title;
    } else if (latest?.status === "done") {
      const what = describe(latest);
      textEl.textContent = msg("badgeDone", what, outcome(latest));
      pill.title = msg("badgeDoneTitle", what, latest.time, outcome(latest));
    } else {
      textEl.textContent = msg("badgeConnected");
      pill.title = msg("badgeConnectedTitle", env.name);
    }
  }

  function shutdown() {
    clearInterval(pollTimer);
    removePill();
  }

  function poll() {
    if (!isAlive()) {
      shutdown();
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "GET_STATUS", light: true }, (status) => {
        if (chrome.runtime.lastError) return;
        render(status);
      });
    } catch (error) {
      shutdown();
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "BADGE_STATUS") render(message.status);
  });

  window.addEventListener("hashchange", () => render(lastStatus));

  chrome.storage.local.get({ badgeCollapsed: false }, (stored) => {
    collapsed = Boolean(stored?.badgeCollapsed);
    applyCollapsed();
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  });
})();
