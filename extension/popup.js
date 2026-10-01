const DEFAULT_WS_PORT = 47831;
const ENVIRONMENT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;

let lastStatus = null;
let activeTab = null;
let peeked = undefined;
let confirmRemove = null;
let envSignature = null;
let activitySignature = null;
let portHydrated = false;

const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;
const byId = (id) => document.getElementById(id);

function applyI18n(root) {
  root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}

document.documentElement.lang = chrome.i18n.getUILanguage();
applyI18n(document);
byId("version-line").textContent = t("versionLine", chrome.runtime.getManifest().version);

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

const environmentKey = (env) => env.origin + env.basePath;
const sameEnvironment = (a, b) => environmentKey(a) === environmentKey(b);

function originPattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

function storedEnvironments() {
  return (lastStatus?.environments || []).map(({ name, envId, origin, basePath }) => ({ name, envId, origin, basePath }));
}

function showMessage(id, text, ok) {
  const el = byId(id);
  el.textContent = text;
  el.classList.remove("ok", "err");
  if (text) el.classList.add(ok ? "ok" : "err");
}

function renderConnection(status) {
  const dot = byId("ws-dot");
  const value = byId("ws-status");
  dot.classList.remove("green", "red");
  value.classList.remove("ok", "err");
  byId("ws-label").textContent = t("mcpServerPort", status.wsPort);
  if (status.wsConnected) {
    dot.classList.add("green");
    value.classList.add("ok");
    value.textContent = t("wsConnected");
  } else {
    dot.classList.add("red");
    value.classList.add("err");
    value.textContent = t("wsNotRunning");
  }
  byId("ws-hint").hidden = status.wsConnected;
}

function renderUpdate(status) {
  const update = status.update || {};
  const outdated = update.extension === "outdated";
  const newer = update.extension === "newer";
  const serverUpdate = Boolean(update.serverUpdate);
  byId("update-extension").hidden = !outdated;
  byId("update-restart").hidden = !newer;
  byId("update-server").hidden = !serverUpdate;
  if (outdated) byId("update-extension-text").textContent = t("updateExtensionText", update.serverVersion, update.extensionVersion);
  if (newer) byId("update-restart-text").textContent = t("updateRestartText", update.serverVersion, update.extensionVersion);
  if (serverUpdate) byId("update-server-text").textContent = t("updateServerText", update.latestVersion, update.serverVersion);
}

function environmentCard(env) {
  const card = element("div", "env-card");
  const head = element("div", "env-head");
  const hasTab = env.tabCount > 0;

  head.appendChild(element("span", `dot ${hasTab ? "green" : "yellow"}`));

  const name = element("input", "env-name");
  name.type = "text";
  name.spellcheck = false;
  name.value = env.name;
  name.title = t("renameEnvTitle");
  name.addEventListener("change", () => renameEnvironment(env, name.value));
  name.addEventListener("keydown", (event) => {
    if (event.key === "Enter") name.blur();
  });
  head.appendChild(name);

  const open = element("button", `open-btn ${hasTab ? "ok" : ""}`);
  if (hasTab) {
    open.textContent = Number(env.tabCount) === 1 ? t("tabsGoOne", env.tabCount) : t("tabsGoMany", env.tabCount);
    open.title = t("switchToTabTitle");
  } else {
    open.textContent = t("openEnv");
    open.title = t("openInNewTabTitle");
  }
  open.addEventListener("click", () => openEnvironment(env));
  head.appendChild(open);

  const armed = confirmRemove === environmentKey(env);
  const remove = element("button", `trash-btn ${armed ? "armed" : ""}`, armed ? t("confirmDelete") : "✕");
  remove.title = t("removeEnvTitle", env.name);
  remove.addEventListener("click", () => {
    if (confirmRemove === environmentKey(env)) {
      confirmRemove = null;
      removeEnvironment(env);
    } else {
      confirmRemove = environmentKey(env);
      render(lastStatus);
    }
  });
  head.appendChild(remove);
  card.appendChild(head);

  const meta = element("div", "env-meta");
  meta.appendChild(element("div", "env-id", env.envId || env.basePath || "/"));
  meta.appendChild(element("div", "", env.origin));
  meta.appendChild(element("div", "", hasTab ? t("tabOpen") : t("tabClosed")));
  if (!env.permitted) meta.appendChild(element("div", "warn", t("noSiteAccess")));
  card.appendChild(meta);
  return card;
}

function renderEnvironments(status) {
  const container = byId("env-rows");
  const environments = status.environments || [];
  const signature = JSON.stringify([environments, confirmRemove]);
  if (signature === envSignature) return;
  const editing = document.activeElement?.classList.contains("env-name") && container.contains(document.activeElement);
  if (editing) return;
  envSignature = signature;
  if (environments.length === 0) {
    container.replaceChildren(element("span", "empty", t("environmentsNone")));
    return;
  }
  container.replaceChildren(...environments.map(environmentCard));
}

function formatDuration(ms) {
  if (typeof ms !== "number") return "";
  return ms < 1000 ? t("durationMs", ms) : t("durationSeconds", (ms / 1000).toFixed(1));
}

function activityState(entry) {
  if (entry.status === "running") return { className: "busy", text: t("activityRunning") };
  if (entry.status === "error") return { className: "err", text: entry.errorCode || t("activityFailed") };
  return { className: "ok", text: entry.httpStatus === null ? t("activityDone") : t("activityHttp", entry.httpStatus) };
}

function activityCard(entry) {
  const card = element("div", "activity");
  const head = element("div", "activity-head");
  head.appendChild(element("span", "tool", entry.tool || t("activityRequestTool")));
  const state = activityState(entry);
  head.appendChild(element("span", `state ${state.className}`, state.text));
  card.appendChild(head);
  if (entry.label) card.appendChild(element("div", "label", entry.label));
  const meta = [entry.environment, entry.time, formatDuration(entry.durationMs)];
  if (entry.polls > 0) meta.push(Number(entry.polls) === 1 ? t("pollsOne", entry.polls) : t("pollsMany", entry.polls));
  card.appendChild(element("div", "meta", meta.filter(Boolean).join(" · ")));
  if (entry.status === "error" && entry.error) card.appendChild(element("div", "error", entry.error));
  return card;
}

function renderActivity(status) {
  const entries = status.activity || [];
  const signature = JSON.stringify(entries);
  if (signature === activitySignature) return;
  activitySignature = signature;
  const container = byId("activity-list");
  if (entries.length === 0) {
    container.replaceChildren(element("span", "empty", t("noActivity")));
    return;
  }
  container.replaceChildren(...entries.map(activityCard));
}

function render(status) {
  if (!status) return;
  lastStatus = status;
  renderConnection(status);
  renderUpdate(status);
  renderEnvironments(status);
  renderActivity(status);
  updateAddButton();
  if (!portHydrated) {
    portHydrated = true;
    byId("ws-port").value = status.wsPort || DEFAULT_WS_PORT;
  }
}

async function openEnvironment(env) {
  const base = environmentKey(env);
  const tabs = await chrome.tabs.query({ url: originPattern(env.origin) });
  const tab = tabs.find((candidate) => typeof candidate.url === "string" && (candidate.url === base || candidate.url.startsWith(`${base}/`)));
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: `${base}/` });
  }
}

async function renameEnvironment(env, rawName) {
  const name = rawName.trim();
  envSignature = null;
  if (name === env.name) return;
  const environments = storedEnvironments();
  if (!name) {
    showMessage("env-msg", t("errNameRequired"), false);
    return;
  }
  if (!ENVIRONMENT_NAME.test(name)) {
    showMessage("env-msg", t("errInvalidName"), false);
    return;
  }
  if (environments.some((other) => !sameEnvironment(other, env) && other.name.toLowerCase() === name.toLowerCase())) {
    showMessage("env-msg", t("errDuplicateName", name), false);
    return;
  }
  await chrome.storage.sync.set({
    environments: environments.map((other) => (sameEnvironment(other, env) ? { ...other, name } : other)),
  });
  showMessage("env-msg", t("renamedEnv", name), true);
  poll();
}

async function removeEnvironment(env) {
  const environments = storedEnvironments().filter((other) => !sameEnvironment(other, env));
  await chrome.storage.sync.set({ environments });
  if (!environments.some((other) => other.origin === env.origin)) {
    chrome.permissions.remove({ origins: [originPattern(env.origin)] }).catch(() => {});
  }
  showMessage("env-msg", t("removedEnv", env.name), true);
  poll();
}

function showNotice(text, className) {
  const notice = byId("page-notice");
  notice.hidden = !text;
  notice.textContent = text || "";
  notice.classList.remove("warn", "ok");
  if (className) notice.classList.add(className);
}

function activeTabLooksLikeEnvironment() {
  try {
    const url = new URL(activeTab.url);
    return /^https?:$/.test(url.protocol) && /^\/e\/([^/]+)/.test(url.pathname);
  } catch (error) {
    return false;
  }
}

function updateAddButton() {
  const button = byId("add-env-btn");
  const hint = byId("add-env-hint");
  if (button.dataset.busy) return;
  button.hidden = true;
  hint.hidden = true;
  if (peeked === undefined) {
    showNotice("", null);
    return;
  }
  if (!peeked || !peeked.readable || !peeked.isDynatrace) {
    showNotice(activeTab?.url && activeTabLooksLikeEnvironment() ? t("pageNotReadable") : t("notDynatracePage"), "warn");
    return;
  }
  const existing = (lastStatus?.environments || []).find((env) => sameEnvironment(env, peeked));
  if (existing) {
    showNotice(t("alreadyAdded", existing.name), "ok");
    return;
  }
  if (!peeked.loggedIn) {
    showNotice(t("notLoggedIn"), "warn");
    return;
  }
  showNotice("", null);
  button.hidden = false;
  button.disabled = false;
  button.textContent = t("addThisEnvironment", peeked.suggestedName || peeked.envId);
  hint.hidden = peeked.permitted === true;
}

function peekActiveTab() {
  if (!activeTab?.id) {
    peeked = null;
    updateAddButton();
    return;
  }
  chrome.runtime.sendMessage({ type: "PEEK_ENVIRONMENT", tabId: activeTab.id }, async (result) => {
    const described = chrome.runtime.lastError ? null : result || null;
    if (described?.origin) {
      described.permitted = await chrome.permissions.contains({ origins: [originPattern(described.origin)] }).catch(() => false);
    }
    peeked = described;
    updateAddButton();
  });
}

async function addCurrentEnvironment() {
  const button = byId("add-env-btn");
  const pattern = originPattern(peeked.origin);
  button.dataset.busy = "1";
  button.disabled = true;

  const already = await chrome.permissions.contains({ origins: [pattern] });
  if (!already) {
    await chrome.runtime.sendMessage({ type: "PREPARE_ADD_ENVIRONMENT", tabId: activeTab.id, pattern });
    button.textContent = t("allowSiteAccess");
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) {
      await chrome.runtime.sendMessage({ type: "CANCEL_ADD_ENVIRONMENT", pattern });
      delete button.dataset.busy;
      updateAddButton();
      showMessage("env-msg", t("siteAccessDenied"), false);
      return;
    }
  }

  button.textContent = t("addingEnvironment");
  const result = await chrome.runtime.sendMessage({ type: "ADD_ENVIRONMENT", tabId: activeTab.id, pattern });
  delete button.dataset.busy;
  if (result?.error) {
    updateAddButton();
    showMessage("env-msg", result.error, false);
    return;
  }
  showMessage("env-msg", t("addedEnv", result.name, result.envId), true);
  poll();
}

async function saveSettings() {
  const wsPort = Number.parseInt(byId("ws-port").value, 10);
  if (!(wsPort >= 1 && wsPort <= 65535)) {
    showMessage("save-msg", t("errInvalidPort"), false);
    return;
  }
  await chrome.storage.sync.set({ wsPort });
  showMessage("save-msg", t("saved"), true);
  poll();
}

function poll() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (status) => {
    if (chrome.runtime.lastError) return;
    render(status);
  });
}

byId("save-btn").addEventListener("click", () => {
  saveSettings().catch((error) => showMessage("save-msg", error.message, false));
});

byId("add-env-btn").addEventListener("click", () => {
  addCurrentEnvironment().catch((error) => {
    delete byId("add-env-btn").dataset.busy;
    updateAddButton();
    showMessage("env-msg", error.message, false);
  });
});

byId("gear-btn").addEventListener("click", () => {
  const section = byId("settings-section");
  section.hidden = !section.hidden;
});

function wireCopy(buttonId, sourceId) {
  byId(buttonId).addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(byId(sourceId).textContent);
      button.textContent = t("copied");
      setTimeout(() => { button.textContent = t("copy"); }, 1500);
    } catch (error) {
      button.textContent = t("copy");
    }
  });
}

wireCopy("copy-cmd", "install-cmd");
wireCopy("copy-update-cmd", "update-cmd");

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  activeTab = tabs?.[0] || null;
  peekActiveTab();
});

poll();
const pollTimer = setInterval(poll, 1000);
window.addEventListener("unload", () => clearInterval(pollTimer));
