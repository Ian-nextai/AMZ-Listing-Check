const MIN_INTERVAL_MS = 10000;
const BLOB_URL_TTL_MS = 60000;

let keepAliveTimerId = null;
let keepAliveExecutionToken = 0;
let keepAliveIntervalMs = 0;

const activeBlobUrls = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  if (message.type === "start-keepalive") {
    startKeepAlive(message);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "stop-keepalive") {
    stopKeepAlive();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "create-blob-url") {
    sendResponse(createBlobUrl(message));
    return true;
  }

  return false;
});

// Large workbooks blow past the practical data: URL length, so the bytes are
// handed to a blob object URL that the downloads API can stream instead.
function createBlobUrl(message) {
  try {
    const base64 = String(message?.base64 || "").replace(/^data:[^;]+;base64,/, "");
    if (!base64) {
      return { ok: false, error: "缺少文件内容。" };
    }

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    const blob = new Blob([bytes], { type: message?.mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    activeBlobUrls.add(url);
    setTimeout(() => releaseBlobUrl(url), BLOB_URL_TTL_MS);

    return { ok: true, url };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function releaseBlobUrl(url) {
  if (!activeBlobUrls.has(url)) {
    return;
  }

  activeBlobUrls.delete(url);
  try {
    URL.revokeObjectURL(url);
  } catch (error) {
    console.debug("Unable to revoke blob url.", error);
  }
}

function startKeepAlive(message) {
  const executionToken = Number(message?.executionToken) || 0;
  if (!executionToken) {
    return;
  }

  const intervalMs = Math.max(MIN_INTERVAL_MS, Number(message?.intervalMs) || MIN_INTERVAL_MS);
  if (
    keepAliveTimerId &&
    keepAliveExecutionToken === executionToken &&
    keepAliveIntervalMs === intervalMs
  ) {
    return;
  }

  stopKeepAlive();
  keepAliveExecutionToken = executionToken;
  keepAliveIntervalMs = intervalMs;
  keepAliveTimerId = setInterval(() => {
    void pingBackground();
  }, intervalMs);
}

function stopKeepAlive() {
  if (keepAliveTimerId) {
    clearInterval(keepAliveTimerId);
  }

  keepAliveTimerId = null;
  keepAliveExecutionToken = 0;
  keepAliveIntervalMs = 0;
}

async function pingBackground() {
  if (!keepAliveExecutionToken) {
    stopKeepAlive();
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "offscreen-keepalive-ping",
      executionToken: keepAliveExecutionToken,
      sentAt: Date.now()
    });

    if (response?.stop) {
      stopKeepAlive();
    }
  } catch (error) {
    console.debug("Offscreen keepalive ping failed.", error);
  }
}

window.addEventListener("unload", () => {
  stopKeepAlive();
});
