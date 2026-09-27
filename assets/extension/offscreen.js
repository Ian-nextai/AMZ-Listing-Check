import { createWorkbookBytes } from "./src/core/workbook.js";
import { readExportPayload } from "./src/core/export-relay.js";

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

  if (message.type === "create-workbook-blob-url") {
    void createWorkbookBlobUrl(message).then(sendResponse);
    return true;
  }

  return false;
});

// Large workbooks blow past the practical data: URL length, so the bytes are
// handed to a blob object URL that the downloads API can stream instead.
//
// The workbook is assembled here rather than in the service worker because
// extension messaging is JSON, not structured clone: raw bytes cannot cross
// contexts. Only the *inputs* are JSON-safe, so the worker puts rows plus
// base64 image placements in Cache Storage (messaging also has a size cap, and
// the image payload is the same order of magnitude as it) and sends just the
// key — that keeps the 1.33x base64 of a multi-MB workbook out of the process
// running the crawl.
async function createWorkbookBlobUrl(message) {
  try {
    const payload = await readExportPayload(message?.payloadKey);
    if (!payload) {
      return { ok: false, error: "找不到导出载荷。" };
    }

    const bytes = createWorkbookBytes(
      payload.rows || [],
      payload.placements || [],
      payload.selectedChecks || {}
    );

    if (!bytes || !bytes.length) {
      return { ok: false, error: "生成的工作簿为空。" };
    }

    const blob = new Blob([bytes], { type: message?.mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    activeBlobUrls.add(url);
    setTimeout(() => releaseBlobUrl(url), BLOB_URL_TTL_MS);

    return { ok: true, url, bytes: bytes.length };
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
