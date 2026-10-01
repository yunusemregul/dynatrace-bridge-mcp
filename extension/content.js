(() => {
  const isAlive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (error) {
      return false;
    }
  };

  if (window.__dynatraceBridgeContent?.isAlive?.()) return;
  window.__dynatraceBridgeContent = { isAlive };

  const CONTENT_SOURCE = "dynatrace-bridge-content";
  const INJECT_SOURCE = "dynatrace-bridge-inject";
  const PAGE_REPLY_TIMEOUT_MS = 600;
  const MESSAGE_SIZE_ERROR = /maximum allowed (size|length)|message length exceeded|too large/i;
  const waiters = new Map();
  let probeCounter = 0;

  function awaitPageReply(key) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(key);
        resolve(null);
      }, PAGE_REPLY_TIMEOUT_MS);
      waiters.set(key, (reply) => {
        clearTimeout(timer);
        waiters.delete(key);
        resolve(reply);
      });
    });
  }

  function relay(result, onFailure) {
    try {
      chrome.runtime.sendMessage(result).catch(onFailure);
    } catch (error) {
      onFailure(error);
    }
  }

  function reportUnrelayable(message, error) {
    const reason = String(error?.message || error);
    if (!isAlive() || !MESSAGE_SIZE_ERROR.test(reason)) return;
    relay({
      type: "DT_RESULT",
      requestId: message.requestId,
      status: message.status,
      error: "Response too large: the browser refused to pass it from the page to the extension. Use a shorter time window or narrower filters.",
      errorCode: "RESPONSE_TOO_LARGE",
    }, () => {});
  }

  function postToPage(message) {
    window.postMessage({ ...message, source: CONTENT_SOURCE }, window.location.origin);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "DT_REQUEST") {
      awaitPageReply(`ack:${message.requestId}`).then((reply) => sendResponse({ ok: Boolean(reply) }));
      postToPage({
        type: "DT_REQUEST",
        requestId: message.requestId,
        request: message.request,
        basePath: message.basePath,
        deadlineAt: message.deadlineAt,
      });
      return true;
    }
    if (message?.type === "DT_PROBE") {
      const probeId = `${Date.now()}-${++probeCounter}`;
      awaitPageReply(`probe:${probeId}`).then((reply) => {
        sendResponse({ ok: Boolean(reply), inflight: reply?.inflight || [] });
      });
      postToPage({ type: "DT_PROBE", probeId });
      return true;
    }
    return false;
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== INJECT_SOURCE) return;

    if (message.type === "DT_ACK") {
      waiters.get(`ack:${message.requestId}`)?.(message);
      return;
    }
    if (message.type === "DT_PROBE_RESULT") {
      waiters.get(`probe:${message.probeId}`)?.(message);
      return;
    }
    if (message.type !== "DT_RESULT" || !isAlive()) return;
    relay({
      type: "DT_RESULT",
      requestId: message.requestId,
      status: message.status,
      data: message.data,
      polls: message.polls,
      error: message.error,
      errorCode: message.errorCode,
    }, (error) => reportUnrelayable(message, error));
  });
})();
