const POLL_INTERVAL_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 12000;

const dom = {
  statusPill: document.getElementById("status-pill"),
  heartbeatText: document.getElementById("heartbeat-text"),
  currentAsin: document.getElementById("current-asin"),
  progressSummary: document.getElementById("progress-summary"),
  successCount: document.getElementById("success-count"),
  failedCount: document.getElementById("failed-count"),
  progressText: document.getElementById("progress-text"),
  progressBar: document.getElementById("progress-bar"),
  zipCode: document.getElementById("zip-code"),
  downloadFile: document.getElementById("download-file"),
  refreshBtn: document.getElementById("refresh-btn"),
  focusWorkerBtn: document.getElementById("focus-worker-btn"),
  pauseBtn: document.getElementById("pause-btn"),
  resumeBtn: document.getElementById("resume-btn"),
  saveBtn: document.getElementById("save-btn"),
  discardBtn: document.getElementById("discard-btn"),
  log: document.getElementById("log")
};

let refreshTimerId = null;
let heartbeatTimerId = null;

initialize().catch((error) => {
  appendLog(`Runner 初始化失败: ${error.message}`, "log-error");
});

async function initialize() {
  bindEvents();
  await refreshState();
  startRefreshTimer();
  startHeartbeatTimer();
}

function bindEvents() {
  dom.refreshBtn.addEventListener("click", () => {
    void refreshState();
  });

  dom.focusWorkerBtn.addEventListener("click", async () => {
    await sendMessage({ type: "focus-worker-tab" });
  });

  dom.pauseBtn.addEventListener("click", async () => {
    await sendMessage({ type: "pause-task" });
    await refreshState();
  });

  dom.resumeBtn.addEventListener("click", async () => {
    await sendMessage({ type: "resume-task" });
    await refreshState();
  });

  dom.saveBtn.addEventListener("click", async () => {
    await sendMessage({ type: "save-results" });
    await refreshState();
  });

  dom.discardBtn.addEventListener("click", async () => {
    if (!window.confirm("确定要放弃当前任务并清空结果吗？")) {
      return;
    }
    await sendMessage({ type: "discard-task" });
    await refreshState();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "task-paused" || message.type === "task-complete" || message.type === "task-discarded") {
      void refreshState();
      return;
    }

    if (message.type === "log" || message.type === "log-error") {
      appendLog(message.text, message.type);
      return;
    }

    if (message.type === "progress-update") {
      dom.progressText.textContent = message.text || "等待任务更新。";
    }
  });

  window.addEventListener("beforeunload", () => {
    stopRefreshTimer();
    stopHeartbeatTimer();
  });
}

async function refreshState() {
  const state = (await sendMessage({ type: "get-status" })) || {};
  updateUi(state);
}

function updateUi(state) {
  const task = state.task || null;
  const results = Object.values(task?.resultsByAsin || {});
  const completed = Array.isArray(task?.processedAsins) ? task.processedAsins.length : 0;
  const total = Array.isArray(task?.allAsins) ? task.allAsins.length : 0;
  const success = results.filter((item) => item?.status === "success").length;
  const failed = results.filter((item) => item?.status === "failed").length;

  dom.statusPill.textContent = renderStatus(state.status);
  dom.statusPill.className = `status-pill ${state.status || "idle"}`;
  dom.currentAsin.textContent = task?.currentAsin || "-";
  dom.progressSummary.textContent = `${completed} / ${total}`;
  dom.successCount.textContent = String(success);
  dom.failedCount.textContent = String(failed);
  dom.progressText.textContent = state.progress || "等待任务开始。";
  dom.progressBar.style.width = `${deriveProgressPercent(state.status, completed, total)}%`;
  dom.zipCode.textContent = task?.zipCode || "-";
  dom.downloadFile.textContent = task?.downloadFilename || "-";

  dom.pauseBtn.disabled = state.status !== "running";
  dom.resumeBtn.disabled = state.status !== "paused";
  dom.saveBtn.disabled = success === 0 && failed === 0;
  dom.discardBtn.disabled = state.status === "idle";

  renderLogHistory(state.history || []);
  updateDocumentTitle(state.status, completed, total, task?.currentAsin || "");
}

function renderStatus(status) {
  if (status === "running") return "运行中";
  if (status === "paused") return "已暂停";
  if (status === "completed") return "已完成";
  return "待命";
}

function deriveProgressPercent(status, completed, total) {
  if (status === "completed") {
    return 100;
  }
  if (!total) {
    return status === "running" ? 8 : 0;
  }
  return Math.max(0, Math.min(99, Math.round((completed / total) * 100)));
}

function renderLogHistory(history) {
  dom.log.innerHTML = "";
  for (const entry of history) {
    appendLog(entry.text, entry.type, false);
  }
}

function appendLog(text, type = "log", autoScroll = true) {
  const row = document.createElement("div");
  row.className = `log-entry ${type}`;
  row.textContent = text;
  dom.log.appendChild(row);
  if (autoScroll) {
    dom.log.scrollTop = dom.log.scrollHeight;
  }
}

function startRefreshTimer() {
  stopRefreshTimer();
  refreshTimerId = window.setInterval(() => {
    void refreshState();
  }, POLL_INTERVAL_MS);
}

function stopRefreshTimer() {
  if (refreshTimerId) {
    clearInterval(refreshTimerId);
  }
  refreshTimerId = null;
}

function startHeartbeatTimer() {
  stopHeartbeatTimer();
  heartbeatTimerId = window.setInterval(() => {
    void sendRunnerHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  void sendRunnerHeartbeat();
}

function stopHeartbeatTimer() {
  if (heartbeatTimerId) {
    clearInterval(heartbeatTimerId);
  }
  heartbeatTimerId = null;
}

async function sendRunnerHeartbeat() {
  try {
    const response = await sendMessage({
      type: "runner-heartbeat",
      sentAt: Date.now()
    });
    const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    dom.heartbeatText.textContent = response?.activeTask
      ? `Runner 心跳正常 ${timestamp}`
      : `Runner 在线，当前无运行任务 ${timestamp}`;
  } catch (error) {
    dom.heartbeatText.textContent = `Runner 心跳失败: ${error.message}`;
  }
}

function updateDocumentTitle(status, completed, total, currentAsin) {
  if (status === "running" && currentAsin) {
    document.title = `(${completed}/${total}) ${currentAsin} - Amazon Runner`;
    return;
  }
  if (status === "completed") {
    document.title = `完成 ${completed}/${total} - Amazon Runner`;
    return;
  }
  if (status === "paused") {
    document.title = `暂停 ${completed}/${total} - Amazon Runner`;
    return;
  }
  document.title = "Amazon Listing Check Runner";
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}
