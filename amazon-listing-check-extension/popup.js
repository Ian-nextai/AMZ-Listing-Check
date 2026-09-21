import { normalizeAsins, normalizeZipCode } from "./src/core/task-utils.js";
import { hasAnyCheckSelected, normalizeSelectedChecks } from "./src/core/task-state.js";

const CHECKBOX_IDS = {
  title: "check-title",
  titleHighlight: "check-title-highlight",
  rating: "check-rating",
  bulletPoints: "check-bullet-points",
  stockStatus: "check-stock-status",
  deliveryPromise: "check-delivery-promise",
  fulfilmentRoute: "check-fulfilment-route",
  imageA: "check-image-a",
  imageDetail: "check-image-detail",
  criticalReviews: "check-critical-reviews",
  category: "check-category",
  addToCart: "check-add-to-cart",
  seller: "check-seller"
};

// These stay off until the user turns them on; every other check defaults on.
const DEFAULT_OFF_CHECKS = new Set(["criticalReviews", "stockStatus", "deliveryPromise", "fulfilmentRoute"]);

const dom = {
  asinInput: document.getElementById("asin-input"),
  zipCodeInput: document.getElementById("zip-code-input"),
  delaySelect: document.getElementById("delay-select"),
  focusRunnerBtn: document.getElementById("focus-runner-btn"),
  focusWorkerBtn: document.getElementById("focus-worker-btn"),
  startBtn: document.getElementById("start-btn"),
  pauseBtn: document.getElementById("pause-btn"),
  resumeBtn: document.getElementById("resume-btn"),
  saveBtn: document.getElementById("save-btn"),
  discardBtn: document.getElementById("discard-btn"),
  progressText: document.getElementById("progress-text"),
  statusValue: document.getElementById("status-value"),
  currentAsinValue: document.getElementById("current-asin-value"),
  summaryValue: document.getElementById("summary-value"),
  downloadValue: document.getElementById("download-value"),
  log: document.getElementById("log")
};

for (const [key, elementId] of Object.entries(CHECKBOX_IDS)) {
  dom[key] = document.getElementById(elementId);
}

initialize().catch((error) => {
  appendLog(`初始化失败: ${error.message}`, "log-error");
});

async function initialize() {
  await hydrateSavedSettings();
  bindEvents();
  await refreshState();
}

function bindEvents() {
  dom.asinInput.addEventListener("input", persistSavedSettings);
  dom.zipCodeInput.addEventListener("input", persistSavedSettings);
  dom.delaySelect.addEventListener("change", persistSavedSettings);

  for (const key of Object.keys(CHECKBOX_IDS)) {
    dom[key].addEventListener("change", persistSavedSettings);
  }

  dom.focusRunnerBtn.addEventListener("click", async () => {
    await sendMessage({ type: "focus-runner-tab" });
  });

  dom.focusWorkerBtn.addEventListener("click", async () => {
    await sendMessage({ type: "focus-worker-tab" });
  });

  dom.startBtn.addEventListener("click", async () => {
    const asins = normalizeAsins(dom.asinInput.value.split(/\r?\n/));
    if (!asins.length) {
      appendLog("请先输入至少一个 ASIN。", "log-error");
      return;
    }

    const checks = getSelectedChecks();
    if (!hasAnyCheckSelected(checks)) {
      appendLog("请至少勾选一个检查项。", "log-error");
      return;
    }

    const zipCode = normalizeZipCode(dom.zipCodeInput.value) || "10010";
    dom.zipCodeInput.value = zipCode;

    await persistSavedSettings();
    const response = await sendMessage({
      type: "start-new-task",
      asins,
      checks,
      zipCode,
      delayMs: Number(dom.delaySelect.value) || 1000
    });

    if (response?.ok === false) {
      appendLog(response.error || "任务启动失败。", "log-error");
    }

    await refreshState();
  });

  dom.pauseBtn.addEventListener("click", async () => {
    await sendMessage({ type: "pause-task" });
    await refreshState();
  });

  dom.resumeBtn.addEventListener("click", async () => {
    const response = await sendMessage({ type: "resume-task" });
    if (response?.ok === false) {
      appendLog(response.error || "任务恢复失败。", "log-error");
    }
    await refreshState();
  });

  dom.saveBtn.addEventListener("click", async () => {
    const response = await sendMessage({ type: "save-results" });
    if (response?.ok === false) {
      appendLog(response.error || "导出当前结果失败。", "log-error");
    }
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
    if (message.type === "log" || message.type === "log-error") {
      appendLog(message.text, message.type);
      return;
    }

    if (message.type === "progress-update") {
      dom.progressText.textContent = message.text || "等待任务更新。";
      return;
    }

    if (message.type === "task-paused" || message.type === "task-complete" || message.type === "task-discarded") {
      void refreshState();
    }
  });
}

function getSelectedChecks() {
  const checks = {};
  for (const key of Object.keys(CHECKBOX_IDS)) {
    checks[key] = Boolean(dom[key]?.checked);
  }
  return normalizeSelectedChecks(checks);
}

async function hydrateSavedSettings() {
  const saved = await chrome.storage.local.get([
    "savedAsins",
    "savedZipCode",
    "savedDelayMs",
    "savedChecks"
  ]);

  if (typeof saved.savedAsins === "string") {
    dom.asinInput.value = saved.savedAsins;
  }
  if (typeof saved.savedDelayMs === "string" && saved.savedDelayMs) {
    dom.delaySelect.value = saved.savedDelayMs;
  }
  dom.zipCodeInput.value = normalizeZipCode(saved.savedZipCode) || "10010";

  const savedChecks = saved.savedChecks && typeof saved.savedChecks === "object"
    ? saved.savedChecks
    : {};
  for (const key of Object.keys(CHECKBOX_IDS)) {
    // Optional collection stays off until the user opts in.
    dom[key].checked = DEFAULT_OFF_CHECKS.has(key)
      ? savedChecks[key] === true
      : savedChecks[key] !== false;
  }
}

async function persistSavedSettings() {
  await chrome.storage.local.set({
    savedAsins: dom.asinInput.value,
    savedZipCode: normalizeZipCode(dom.zipCodeInput.value) || "10010",
    savedDelayMs: dom.delaySelect.value,
    savedChecks: getSelectedChecks()
  });
}

async function refreshState() {
  const state = await sendMessage({ type: "get-status" });
  updateUi(state || {});
}

function updateUi(state) {
  const task = state.task || null;
  const results = Object.values(task?.resultsByAsin || {});
  const success = results.filter((item) => item?.status === "success").length;
  const failed = results.filter((item) => item?.status === "failed").length;
  const completed = Array.isArray(task?.processedAsins) ? task.processedAsins.length : 0;
  const total = Array.isArray(task?.allAsins) ? task.allAsins.length : 0;

  dom.progressText.textContent = state.progress || "等待任务开始。";
  dom.statusValue.textContent = renderStatus(state.status);
  dom.currentAsinValue.textContent = task?.currentAsin || "-";
  dom.summaryValue.textContent = `${success} / ${failed} (${completed}/${total})`;
  dom.downloadValue.textContent = task?.downloadFilename || "-";

  dom.pauseBtn.disabled = state.status !== "running";
  dom.resumeBtn.disabled = state.status !== "paused";
  dom.saveBtn.disabled = success === 0 && failed === 0;
  dom.discardBtn.disabled = state.status === "idle";
  dom.startBtn.disabled = state.status === "running";

  renderLogHistory(state.history || []);
}

function renderStatus(status) {
  if (status === "running") return "运行中";
  if (status === "paused") return "已暂停";
  if (status === "completed") return "已完成";
  return "待命";
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
