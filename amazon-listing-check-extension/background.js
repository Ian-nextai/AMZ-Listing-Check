import * as XLSX from "./vendor/xlsx.mjs";
import { bytesToDataUrl } from "./src/core/binary.js";
import {
  CRITICAL_REVIEW_LIMIT,
  buildCriticalReviewsUrl,
  detectAmazonRobotCheck,
  detectContinueShoppingGate,
  detectSignInPage,
  extractAmazonListingChecks,
  extractCriticalReviews
} from "./src/core/amazon-parser.js";
import {
  buildExportFilename,
  buildImagePlacements,
  buildWorksheetRows,
  getActiveColumns
} from "./src/core/export-plan.js";
import { fetchImageAsBase64 } from "./src/core/image-fetch.js";
import { dedupeReviews } from "./src/core/review-dedupe.js";
import { embedImagesIntoXlsx } from "./src/core/xlsx-image.js";
import {
  createTask,
  hasAnyCheckSelected,
  normalizeSelectedChecks,
  recordTaskFailure,
  recordTaskSuccess,
  summarizeTask
} from "./src/core/task-state.js";
import {
  isZipCodeAppliedToLocationText,
  normalizeAsins,
  normalizeZipCode
} from "./src/core/task-utils.js";
import { shouldFocusWorkerTab } from "./src/core/focus-policy.js";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const RUNNER_PAGE_URL = chrome.runtime.getURL("runner.html");
const STORAGE_TASK_KEY = "task";
const STORAGE_ACTIVE_TASK_TOKEN_KEY = "taskExecutionToken";
const HISTORY_LIMIT = 250;
const KEEPALIVE_INTERVAL_MS = 20000;
const PAGE_SETTLE_DELAY_MS = 1200;
const TAB_LOAD_TIMEOUT_MS = 45000;
const IMAGE_ROW_HEIGHT_POINTS = 95;

let status = "idle";
let shouldPause = false;
let currentProgress = "";
let logHistory = [];
let activeTaskToken = 0;
let activeTaskRef = null;
let activeRunPromise = null;
// Bumped whenever a run is discarded or superseded. A run whose id no longer
// matches has been abandoned and must stop touching the tab and storage.
let activeRunId = 0;
// Execution tokens of discarded tasks, so a late write from an abandoned run
// cannot resurrect a task the user already threw away.
const cancelledExecutionTokens = new Set();
const CANCELLED_TOKEN_LIMIT = 50;
let workerTabId = null;
let runnerTabId = null;
let creatingOffscreenDocument = null;

// Base64 image payloads stay in memory: persisting them would blow the
// chrome.storage quota on a large batch. Only URLs are saved, and an export
// after a service-worker restart re-downloads whatever the cache lost.
const imageCache = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "get-status") {
    void handleGetStatus(sendResponse);
    return true;
  }

  if (message?.type === "start-new-task") {
    void handleStartNewTask(message, sendResponse);
    return true;
  }

  if (message?.type === "pause-task") {
    shouldPause = status === "running";
    if (shouldPause) {
      updateProgress("已收到暂停请求，当前 ASIN 处理完成后会暂停。");
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "resume-task") {
    void handleResumeTask(sendResponse);
    return true;
  }

  if (message?.type === "save-results") {
    void handleSaveResults(sendResponse);
    return true;
  }

  if (message?.type === "discard-task") {
    void handleDiscardTask(sendResponse);
    return true;
  }

  if (message?.type === "focus-worker-tab") {
    void handleFocusWorkerTab(sendResponse);
    return true;
  }

  if (message?.type === "focus-runner-tab") {
    void handleFocusRunnerTab(sendResponse);
    return true;
  }

  if (message?.type === "runner-heartbeat") {
    void handleRunnerHeartbeat(sendResponse);
    return true;
  }

  if (message?.type === "offscreen-keepalive-ping") {
    void handleOffscreenKeepAlivePing(message, sendResponse);
    return true;
  }

  return false;
});

chrome.runtime.onStartup.addListener(() => {
  void resumeStoredTaskIfNeeded();
});

chrome.runtime.onInstalled.addListener(() => {
  void resumeStoredTaskIfNeeded();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === workerTabId) {
    workerTabId = null;
  }
  if (tabId === runnerTabId) {
    runnerTabId = null;
  }
});

async function handleGetStatus(sendResponse) {
  await resumeStoredTaskIfNeeded();
  const task = await loadTaskFromStorage();
  const snapshot = buildStatusSnapshot(task);

  sendResponse({
    status: snapshot.status,
    progress: snapshot.progress,
    history: snapshot.history,
    task: snapshot.task
  });
}

async function handleStartNewTask(message, sendResponse) {
  if (status === "running" || activeRunPromise) {
    sendResponse({ ok: false, error: "已有任务在运行。" });
    return;
  }

  const asins = normalizeAsins(message?.asins || []);
  if (!asins.length) {
    sendResponse({ ok: false, error: "请输入至少一个有效 ASIN。" });
    return;
  }

  const selectedChecks = normalizeSelectedChecks(message?.checks);
  if (!hasAnyCheckSelected(selectedChecks)) {
    sendResponse({ ok: false, error: "请至少勾选一个检查项。" });
    return;
  }

  const zipCode = normalizeZipCode(message?.zipCode) || "10010";

  logHistory = [];
  currentProgress = "正在准备 Amazon listing 检查任务...";
  status = "running";
  shouldPause = false;

  const task = {
    ...createTask(asins, selectedChecks),
    status: "running",
    progressText: currentProgress,
    zipCode,
    zipCodeApplied: false,
    delayMs: Math.max(0, Number(message?.delayMs) || 1000),
    executionToken: await beginTaskExecution(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    downloadFilename: "",
    workerTabId: null
  };

  await saveTask(task);
  await ensureRunnerTab(false);
  await ensureTaskKeepAlive(task);
  logToUi(`任务已启动，共 ${asins.length} 个 ASIN。`, "log", task);
  sendResponse({ ok: true });
  void startTaskRun(task);
}

async function handleResumeTask(sendResponse) {
  const task = await loadTaskFromStorage();
  if (!task) {
    sendResponse({ ok: false, error: "没有可恢复的任务。" });
    return;
  }

  if (task.status !== "paused") {
    sendResponse({ ok: false, error: "只有暂停任务可以恢复。" });
    return;
  }

  shouldPause = false;
  status = "running";
  task.status = "running";
  task.executionToken = await beginTaskExecution();
  task.updatedAt = Date.now();
  updateProgress(task.progressText || "正在恢复任务...", task);
  await saveTask(task);
  await ensureRunnerTab(false);
  await ensureTaskKeepAlive(task);
  sendResponse({ ok: true });
  void startTaskRun(task);
}

async function handleSaveResults(sendResponse) {
  const task = await loadTaskFromStorage();
  if (!task) {
    sendResponse({ ok: false, error: "当前没有可导出的任务结果。" });
    return;
  }

  try {
    const downloadInfo = await exportTaskAsDownload(task);
    logToUi(`已导出当前结果到 ${downloadInfo.filename}。`, "log", task);
    sendResponse({ ok: true, downloadInfo });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

async function handleDiscardTask(sendResponse) {
  await clearTask();
  logToUi("当前任务已放弃，运行状态已重置。", "log");
  safeSendMessage({ type: "task-discarded" });
  sendResponse({ ok: true });
}

async function handleFocusWorkerTab(sendResponse) {
  try {
    const tab = await ensureWorkerTab(
      "https://www.amazon.com/",
      shouldFocusWorkerTab("user-open-worker")
    );
    sendResponse({ ok: true, tabId: tab.id ?? null });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

async function handleFocusRunnerTab(sendResponse) {
  try {
    const tab = await ensureRunnerTab(true);
    sendResponse({ ok: true, tabId: tab.id ?? null });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

async function handleRunnerHeartbeat(sendResponse) {
  const task = await loadTaskFromStorage();

  if (task?.status === "running" && !isTaskCancelled(task) && status !== "running" && !activeRunPromise) {
    void startTaskRun(task);
  }

  sendResponse({
    ok: true,
    activeTask: task?.status === "running" && !isTaskCancelled(task)
  });
}

// True when the stored task belongs to a run the user already discarded. Such a
// task must never be resumed by a heartbeat or keepalive ping.
function isTaskCancelled(task) {
  const token = Number(task?.executionToken || 0);
  return token > 0 && cancelledExecutionTokens.has(token);
}

async function handleOffscreenKeepAlivePing(message, sendResponse) {
  const token = Number(message?.executionToken) || 0;
  const task = await loadTaskFromStorage();

  if (!task || task.status !== "running" || token !== Number(task.executionToken || 0)) {
    sendResponse({ ok: true, stop: true });
    return;
  }

  if (isTaskCancelled(task)) {
    sendResponse({ ok: true, stop: true });
    return;
  }

  if (status !== "running" && !activeRunPromise) {
    void startTaskRun(task);
  }

  sendResponse({ ok: true, stop: false });
}

async function startTaskRun(task) {
  if (activeRunPromise) {
    return activeRunPromise;
  }

  const runId = ++activeRunId;

  activeRunPromise = (async () => {
    try {
      await runTaskLoop(task, runId);
    } catch (error) {
      await handleTaskError(error, task, runId);
    } finally {
      // Only the newest run may clear the shared handles; an abandoned run
      // finishing late must not release the run that replaced it.
      if (runId === activeRunId) {
        activeRunPromise = null;
        activeTaskRef = null;
      }
    }
  })();

  return activeRunPromise;
}

function isRunStale(runId, task) {
  if (runId !== activeRunId) {
    return true;
  }
  const token = Number(task?.executionToken || 0);
  return token > 0 && cancelledExecutionTokens.has(token);
}

async function runTaskLoop(expectedTask, runId) {
  let task = await loadTaskFromStorage();
  if (!task) {
    return;
  }

  if (isRunStale(runId, task)) {
    return;
  }

  if (expectedTask?.executionToken && task.executionToken !== expectedTask.executionToken) {
    task = expectedTask;
  }

  status = "running";
  shouldPause = false;
  activeTaskRef = task;
  await ensureTaskKeepAlive(task);
  await ensureRunnerTab(false);

  if (isRunStale(runId, task)) {
    return;
  }

  while (task.remainingAsins.length > 0) {
    if (isRunStale(runId, task)) {
      return;
    }

    if (await pauseIfRequested(task, "任务已暂停。")) {
      return;
    }

    const asin = task.remainingAsins[0];
    task.currentAsin = asin;
    task.updatedAt = Date.now();
    updateProgress(
      `正在处理 ${task.processedAsins.length + 1}/${task.allAsins.length}: ${asin}`,
      task
    );
    await saveTask(task);
    logToUi(`开始抓取 ASIN ${asin}。`, "log", task);

    task = await processAsin(task, asin);
    task.updatedAt = Date.now();

    if (isRunStale(runId, task)) {
      return;
    }

    await saveTask(task);

    if (task.remainingAsins.length > 0) {
      const pausedDuringDelay = await sleepWithPauseChecks(task.delayMs);
      if (isRunStale(runId, task)) {
        return;
      }
      if (pausedDuringDelay) {
        await pauseTask(task, "任务已暂停。");
        return;
      }
    }
  }

  await finalizeTask(task);
}

async function processAsin(task, asin) {
  try {
    const url = buildAsinUrl(asin);
    const tab = await ensureWorkerTab(url, shouldFocusWorkerTab("task-run"));
    task.workerTabId = tab.id ?? null;

    if (!task.zipCodeApplied) {
      updateProgress(`正在检查配送邮编 ${task.zipCode}...`, task);
      await saveTask(task);

      // A missing location widget must not discard the listing data, so the
      // zip step degrades to a warning instead of failing the ASIN.
      try {
        const zipCodeResult = await applyZipCodeInWorkerTab(task.zipCode);
        task.zipCodeApplied = true;
        task.updatedAt = Date.now();
        await saveTask(task);
        logToUi(
          zipCodeResult.changed
            ? `配送邮编已设置为 ${task.zipCode}。`
            : `配送邮编 ${task.zipCode} 已一致，跳过重新设置。`,
          "log",
          task
        );
      } catch (zipError) {
        task.zipCodeApplied = true;
        task.updatedAt = Date.now();
        await saveTask(task);
        logToUi(`配送邮编设置失败，继续抓取：${zipError.message}`, "log-error", task);
      }
    }

    // The zip step drives Amazon's location popover, which can leave the tab on
    // another page, so the ASIN url is re-asserted before scraping.
    await ensureWorkerOnUrl(url);

    const pageData = await collectPageDataFromWorkerTab();
    if (detectAmazonRobotCheck(pageData.html)) {
      throw new Error("遇到 Amazon Robot Check 页面。");
    }

    const extractedChecks = extractAmazonListingChecks(pageData.html, task.selectedChecks);
    validateExtractedChecks(task.selectedChecks, extractedChecks, pageData.html);

    const imageResults = await collectListingImages(task.selectedChecks, extractedChecks);
    Object.assign(extractedChecks, imageResults);

    if (task.selectedChecks.criticalReviews) {
      updateProgress(`正在收集 ${asin} 的差评...`, task);
      await saveTask(task);
      Object.assign(extractedChecks, await collectCriticalReviews(task));
    }

    const nextTask = recordTaskSuccess(task, asin, extractedChecks);
    nextTask.status = "running";
    nextTask.currentAsin = "";
    nextTask.progressText = `ASIN ${asin} 抓取完成。`;
    nextTask.updatedAt = Date.now();

    const missingNotes = [
      ...collectMissingFieldNotes(task.selectedChecks, extractedChecks),
      extractedChecks.imageAError,
      extractedChecks.imageDetailError,
      extractedChecks.reviewsError
    ].filter(Boolean);

    // A missing optional field is normal, so it is logged as a plain note
    // rather than an error.
    logToUi(
      missingNotes.length
        ? `ASIN ${asin} 成功，部分字段该 listing 本身没有：${missingNotes.join("、")}。`
        : `ASIN ${asin} 成功，已提取 listing 结果。`,
      "log",
      nextTask
    );
    return nextTask;
  } catch (error) {
    const nextTask = recordTaskFailure(task, asin, error.message);
    nextTask.status = "running";
    nextTask.currentAsin = "";
    nextTask.progressText = `ASIN ${asin} 抓取失败：${error.message}`;
    nextTask.updatedAt = Date.now();
    logToUi(`ASIN ${asin} 失败：${error.message}`, "log-error", nextTask);
    return nextTask;
  }
}

async function clearContinueShoppingGate() {
  const pageData = await collectPageDataFromWorkerTab();
  if (!detectContinueShoppingGate(pageData.html)) {
    return false;
  }

  await chrome.scripting.executeScript({
    target: { tabId: workerTabId },
    world: "MAIN",
    func: () => {
      const button = [...document.querySelectorAll("button, input[type=submit], a")]
        .find((element) => /continue shopping/i.test(element.textContent || element.value || ""));
      if (button) {
        button.click();
        return true;
      }

      const form = document.querySelector("form[action*='validateCaptcha']");
      if (form) {
        form.submit();
        return true;
      }

      return false;
    }
  });

  await waitForTabComplete(workerTabId);
  await sleep(PAGE_SETTLE_DELAY_MS);
  return true;
}

async function collectListingImages(selectedChecks, extractedChecks) {
  const result = {};

  if (selectedChecks?.imageA) {
    const downloaded = await fetchListingImage(extractedChecks.imageAUrl);
    result.imageAData = downloaded;
    result.imageAError = downloaded ? "" : "A图下载失败。";
  }

  if (selectedChecks?.imageDetail) {
    const downloaded = await fetchListingImage(extractedChecks.imageDetailUrl);
    result.imageDetailData = downloaded;
    result.imageDetailError = downloaded ? "" : "详情图下载失败。";
  }

  return result;
}

async function fetchListingImage(url) {
  const target = String(url || "").trim();
  if (!target) {
    return null;
  }

  if (!imageCache.has(target)) {
    imageCache.set(target, await fetchImageAsBase64(target));
  }

  return imageCache.get(target);
}

async function resolveExportImages(results, selectedChecks) {
  const placements = buildImagePlacements(results, selectedChecks);

  return Promise.all(
    placements.map(async (placement) => {
      if (placement.base64) {
        return placement;
      }

      const downloaded = await fetchListingImage(placement.url);
      return downloaded ? { ...placement, base64: downloaded.base64, extension: downloaded.extension } : null;
    })
  ).then((items) => items.filter(Boolean));
}

// Critical reviews come from the dedicated reviews page, reached by splicing
// the ASIN into its URL with filterByStar=critical. That page needs a signed-in
// session, so an unauthenticated run falls back to whatever the detail page
// medley already exposes.
async function collectCriticalReviews(task) {
  const asin = task.currentAsin || task.remainingAsins?.[0] || "";

  try {
    const detailHtml = await expandAndReadReviewMedley();
    const fromDetail = extractCriticalReviews(detailHtml);

    if (fromDetail.length >= CRITICAL_REVIEW_LIMIT) {
      return { criticalReviews: fromDetail, reviewPageUrl: "", reviewsError: "" };
    }

    const pageResult = await collectReviewsFromReviewPage(asin, detailHtml);
    return pageResult;
  } catch (error) {
    return { criticalReviews: [], reviewPageUrl: "", reviewsError: `差评收集失败：${error.message}` };
  }
}

// Scrolls the page so reviews mount, then clicks "Show N more reviews" until
// the target count is reached (or the page stops growing) before returning the
// final HTML. Works on both the detail page medley and the all-reviews page.
async function expandAndReadReviewMedley(targetCount = CRITICAL_REVIEW_LIMIT) {
  if (!Number.isInteger(workerTabId)) {
    throw new Error("工作标签页不可用。");
  }

  await chrome.scripting.executeScript({
    target: { tabId: workerTabId },
    world: "MAIN",
    args: [targetCount],
    func: async (target) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const count = () => document.querySelectorAll('[data-hook="review"]').length;

      const scrollThrough = async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 600) {
          window.scrollTo(0, y);
          await sleep(140);
        }
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(1500);
      };

      await scrollThrough();

      // Some bodies start collapsed behind an expand control.
      for (const control of document.querySelectorAll(
        '[data-hook="reviewExpandButtonContainer"] a, [data-hook="reviewExpandButtonContainer"] span, .review-expand-button'
      )) {
        try {
          control.click();
        } catch (error) {
          // A non-clickable node is fine; the text is readable either way.
        }
      }
      await sleep(1000);

      for (let round = 0; round < 15; round += 1) {
        if (count() >= target) {
          break;
        }

        const link = document.querySelector('a[data-hook="show-more-button"]');
        if (!link) {
          break;
        }

        link.scrollIntoView({ block: "center" });
        await sleep(500);

        const before = count();
        link.click();
        await sleep(6000);

        if (count() <= before) {
          break;
        }
      }
    }
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId: workerTabId },
    world: "MAIN",
    func: () => document.documentElement.outerHTML
  });

  return String(results?.[0]?.result || "");
}

async function collectReviewsFromReviewPage(asin, detailHtml) {
  const url = buildCriticalReviewsUrl(asin);
  if (!url) {
    return { criticalReviews: extractCriticalReviews(detailHtml), reviewPageUrl: "", reviewsError: "" };
  }

  try {
    const result = await withWorkerTabOnUrl(url, asin, async () => {
      const html = await expandAndReadReviewMedley();
      if (detectSignInPage(html)) {
        return { signIn: true, reviews: [] };
      }
      return { signIn: false, reviews: extractCriticalReviews(html) };
    });

    if (result?.signIn) {
      return {
        criticalReviews: extractCriticalReviews(detailHtml),
        reviewPageUrl: url,
        reviewsError: "评论页需要登录 Amazon，已改用详情页评论。"
      };
    }

    // The reviews page is the authoritative, already-filtered source. The
    // detail page shows the same reviews with truncated bodies, so merging the
    // two would list each review twice. Only fall back when it found nothing.
    const pageReviews = dedupeReviews(result?.reviews || []);
    const criticalReviews = pageReviews.length
      ? pageReviews
      : dedupeReviews(extractCriticalReviews(detailHtml));

    return {
      criticalReviews: criticalReviews.slice(0, CRITICAL_REVIEW_LIMIT),
      reviewPageUrl: url,
      reviewsError: ""
    };
  } catch (error) {
    return {
      criticalReviews: extractCriticalReviews(detailHtml),
      reviewPageUrl: url,
      reviewsError: `评论页抓取失败：${error.message}`
    };
  }
}

// Temporarily points the worker tab at another URL, then returns it to the ASIN.
async function withWorkerTabOnUrl(url, asin, run) {
  const asinUrl = buildAsinUrl(asin);

  await chrome.tabs.update(workerTabId, { url });
  await waitForTabComplete(workerTabId);
  await sleep(PAGE_SETTLE_DELAY_MS);

  try {
    return await run();
  } finally {
    await chrome.tabs.update(workerTabId, { url: asinUrl });
    await waitForTabComplete(workerTabId);
    await sleep(PAGE_SETTLE_DELAY_MS);
  }
}

async function finalizeTask(task) {
  const summary = summarizeTask(task);
  const downloadInfo = await exportTaskAsDownload(task);

  status = "completed";
  shouldPause = false;
  task.status = "completed";
  task.progressText = `任务完成。成功 ${summary.success} 个，失败 ${summary.failed} 个。`;
  currentProgress = task.progressText;
  task.downloadFilename = downloadInfo.filename;
  task.updatedAt = Date.now();
  await saveTask(task);
  logToUi(`任务完成，结果已导出为 ${downloadInfo.filename}。`, "log", task);

  await stopTaskKeepAlive();
  safeSendMessage({ type: "task-complete" });
}

async function exportTaskAsDownload(task) {
  const results = task.allAsins
    .map((asin) => task.resultsByAsin?.[asin])
    .filter(Boolean);

  if (!results.length) {
    throw new Error("当前没有可导出的结果。");
  }

  const rows = buildWorksheetRows(results, task.selectedChecks);
  const placements = await resolveExportImages(results, task.selectedChecks);
  const bytes = createWorkbookBytes(rows, placements, task.selectedChecks);
  const filename = buildExportFilename();
  const downloadId = await downloadBlob(
    bytes,
    filename,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );

  task.downloadFilename = filename;
  task.downloadId = downloadId;
  task.updatedAt = Date.now();
  await saveTask(task);
  return { filename, downloadId };
}

function createWorkbookBytes(rows, imagePlacements, selectedChecks) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const columns = getActiveColumns(selectedChecks);

  worksheet["!cols"] = columns.map((column) => ({ wch: column.width || 20 }));

  if (imagePlacements.length) {
    const imageColumnIndexes = columns
      .map((column, index) => (column.key === "imageA" || column.key === "imageDetail" ? index : -1))
      .filter((index) => index >= 0);

    worksheet["!rows"] = rows.map((row, rowIndex) =>
      rowIndex === 0 || !imageColumnIndexes.length ? {} : { hpt: IMAGE_ROW_HEIGHT_POINTS }
    );
  }

  XLSX.utils.book_append_sheet(workbook, worksheet, "Amazon Listing Checks");
  const buffer = XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx"
  });

  if (!imagePlacements.length) {
    return new Uint8Array(buffer);
  }

  return embedImagesIntoXlsx(new Uint8Array(buffer), imagePlacements);
}

async function pauseTask(task, message) {
  status = "paused";
  shouldPause = false;
  currentProgress = message;
  task.status = "paused";
  task.progressText = message;
  task.updatedAt = Date.now();
  await saveTask(task);
  logToUi(message, "log", task);
  await stopTaskKeepAlive();
  safeSendMessage({ type: "task-paused" });
}

async function pauseIfRequested(task, pauseMessage) {
  if (!shouldPause) {
    return false;
  }

  await pauseTask(task, pauseMessage);
  return true;
}

async function handleTaskError(error, task, runId) {
  if (isRunStale(runId, task)) {
    return;
  }

  const liveTask = (await loadTaskFromStorage()) || task;
  if (!liveTask) {
    return;
  }

  if (isRunStale(runId, liveTask)) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  liveTask.status = "paused";
  liveTask.progressText = message;
  liveTask.updatedAt = Date.now();
  status = "paused";
  shouldPause = false;
  currentProgress = message;
  await saveTask(liveTask);
  logToUi(`任务因错误暂停：${message}`, "log-error", liveTask);
  await stopTaskKeepAlive();
  safeSendMessage({ type: "task-paused" });
}

async function resumeStoredTaskIfNeeded() {
  if (activeRunPromise) {
    return;
  }

  const task = await loadTaskFromStorage();
  if (!task || task.status !== "running" || isTaskCancelled(task)) {
    return;
  }

  void startTaskRun(task);
}

async function beginTaskExecution() {
  activeTaskToken = createExecutionToken();
  await chrome.storage.local.set({ [STORAGE_ACTIVE_TASK_TOKEN_KEY]: activeTaskToken });
  return activeTaskToken;
}

function createExecutionToken() {
  const now = Date.now();
  return now > activeTaskToken ? now : activeTaskToken + 1;
}

async function saveTask(task) {
  // A discarded task must not be written back by a run that is winding down.
  const token = Number(task?.executionToken || 0);
  if (token && cancelledExecutionTokens.has(token)) {
    return;
  }

  const runtimeTask = {
    ...task,
    resultsByAsin: stripImageData(task?.resultsByAsin),
    progressText: currentProgress || task.progressText || "",
    history: logHistory
  };
  activeTaskRef = runtimeTask;
  await chrome.storage.local.set({ [STORAGE_TASK_KEY]: runtimeTask });
}

function stripImageData(resultsByAsin) {
  const next = {};
  for (const [asin, result] of Object.entries(resultsByAsin || {})) {
    next[asin] = { ...result, imageAData: null, imageDetailData: null };
  }
  return next;
}

async function loadTaskFromStorage() {
  const stored = await chrome.storage.local.get(STORAGE_TASK_KEY);
  return stored?.[STORAGE_TASK_KEY] || null;
}

async function clearTask() {
  // Abandon whatever is running: bumping the run id makes the in-flight loop
  // bail at its next checkpoint instead of writing the old task back.
  const runningTask = activeTaskRef || (await loadTaskFromStorage());
  const token = Number(runningTask?.executionToken || 0);
  if (token) {
    cancelledExecutionTokens.add(token);
    // Keep the set bounded across a long session; older tokens can no longer
    // be in flight by the time they would fall out.
    while (cancelledExecutionTokens.size > CANCELLED_TOKEN_LIMIT) {
      cancelledExecutionTokens.delete(cancelledExecutionTokens.values().next().value);
    }
  }

  activeRunId += 1;
  activeRunPromise = null;
  status = "idle";
  shouldPause = false;
  currentProgress = "";
  logHistory = [];
  activeTaskRef = null;
  await chrome.storage.local.remove([STORAGE_TASK_KEY, STORAGE_ACTIVE_TASK_TOKEN_KEY]);
  await stopTaskKeepAlive();
}

function buildStatusSnapshot(task) {
  const runtimeStatus = normalizeStatus(status);
  const storedStatus = normalizeStatus(task?.status);
  // A cancelled task's leftovers are not "runtime activity"; without this the
  // popup would report idle storage with a stale running progress line.
  const cancelled = isTaskCancelled(task);
  const hasRuntimeActivity = !cancelled && Boolean(currentProgress || logHistory.length || activeRunPromise);
  const effectiveStatus = hasRuntimeActivity ? runtimeStatus : storedStatus;

  return {
    status: effectiveStatus,
    progress: cancelled ? "" : currentProgress || task?.progressText || "",
    history: cancelled ? [] : logHistory.length ? logHistory : task?.history || [],
    task: task
      ? {
          ...task,
          status: effectiveStatus,
          progressText: cancelled ? "" : currentProgress || task.progressText || "",
          history: cancelled ? [] : logHistory.length ? logHistory : task.history || []
        }
      : null
  };
}

function normalizeStatus(value) {
  return ["idle", "running", "paused", "completed"].includes(value) ? value : "idle";
}

// A run that is winding down after the user discarded its task must not touch
// the shared progress/log state, or it would repaint the popup with the dead
// task and leave the status stuck between idle and running.
function isCancelledWrite(task) {
  return Boolean(task) && isTaskCancelled(task);
}

function updateProgress(text, task = null) {
  if (isCancelledWrite(task)) {
    return;
  }

  currentProgress = text;
  if (task) {
    task.progressText = text;
  }
  safeSendMessage({ type: "progress-update", text });
}

function logToUi(text, type = "log", task = null) {
  if (isCancelledWrite(task)) {
    return;
  }

  const entry = {
    text: normalizeText(text),
    type,
    timestamp: Date.now()
  };

  logHistory = [...logHistory, entry].slice(-HISTORY_LIMIT);
  if (task) {
    task.history = logHistory;
  }

  safeSendMessage({ type, text: entry.text });
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeSendMessage(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function buildAsinUrl(asin) {
  return `https://www.amazon.com/dp/${encodeURIComponent(asin)}`;
}

async function ensureRunnerTab(focus) {
  if (Number.isInteger(runnerTabId)) {
    try {
      const tab = await chrome.tabs.get(runnerTabId);
      if (focus) {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      }
      return tab;
    } catch (error) {
      runnerTabId = null;
    }
  }

  const existingTabs = await chrome.tabs.query({ url: RUNNER_PAGE_URL });
  if (existingTabs.length > 0) {
    const tab = existingTabs[0];
    runnerTabId = tab.id ?? null;
    if (focus) {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    }
    return tab;
  }

  const tab = await chrome.tabs.create({
    url: RUNNER_PAGE_URL,
    active: Boolean(focus)
  });
  runnerTabId = tab.id ?? null;
  return tab;
}

async function ensureWorkerTab(url, focus) {
  if (!Number.isInteger(workerTabId)) {
    const tab = await chrome.tabs.create({
      url,
      active: Boolean(focus)
    });
    workerTabId = tab.id ?? null;
    await waitForTabComplete(workerTabId);
    await sleep(PAGE_SETTLE_DELAY_MS);
    await ensureGateCleared(url);
    return chrome.tabs.get(workerTabId);
  }

  const currentTab = await chrome.tabs.get(workerTabId);
  if (currentTab.url === url && currentTab.status === "complete") {
    if (focus) {
      await chrome.tabs.update(workerTabId, { active: true });
      if (currentTab.windowId) {
        await chrome.windows.update(currentTab.windowId, { focused: true });
      }
    }
    await sleep(PAGE_SETTLE_DELAY_MS);
    await ensureGateCleared(url);
    return chrome.tabs.get(workerTabId);
  }

  const tab = await chrome.tabs.update(workerTabId, {
    url,
    active: Boolean(focus)
  });
  if (focus && tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  await waitForTabComplete(workerTabId);
  await sleep(PAGE_SETTLE_DELAY_MS);
  await ensureGateCleared(url);
  return chrome.tabs.get(workerTabId);
}

async function ensureWorkerOnUrl(url) {
  if (!Number.isInteger(workerTabId)) {
    throw new Error("工作标签页不可用。");
  }

  const tab = await chrome.tabs.get(workerTabId);
  if (tab.url === url && tab.status === "complete") {
    return;
  }

  await chrome.tabs.update(workerTabId, { url });
  await waitForTabComplete(workerTabId);
  await sleep(PAGE_SETTLE_DELAY_MS);
  await ensureGateCleared(url);
}

// Passing the gate signs the session in but lands on the home page, so the
// requested URL is loaded again once the interstitial is cleared.
async function ensureGateCleared(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cleared = await clearContinueShoppingGate();
    if (!cleared) {
      return attempt > 0;
    }

    logToUi("已通过 Amazon 继续购物确认页。", "log");

    await chrome.tabs.update(workerTabId, { url });
    await waitForTabComplete(workerTabId);
    await sleep(PAGE_SETTLE_DELAY_MS);
  }

  return true;
}

async function collectPageDataFromWorkerTab() {
  if (!Number.isInteger(workerTabId)) {
    throw new Error("工作标签页不可用。");
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: workerTabId },
    world: "MAIN",
    func: () => ({
      html: document.documentElement.outerHTML,
      title: document.title,
      url: location.href
    })
  });

  return results?.[0]?.result || { html: "", title: "", url: "" };
}

async function applyZipCodeInWorkerTab(zipCode) {
  if (!Number.isInteger(workerTabId)) {
    throw new Error("工作标签页不可用，无法设置邮编。");
  }

  const currentLocation = await readWorkerLocationText();
  if (isZipCodeAppliedToLocationText(currentLocation, zipCode)) {
    return { changed: false };
  }

  // The location popover hides its zip field behind a country dropdown and
  // often never reveals it, so the delivery address is set through the same
  // endpoint the popover itself calls.
  const response = await setDeliveryZipViaEndpoint(zipCode);
  if (!response?.ok) {
    throw new Error(response?.error || "邮编设置请求失败。");
  }

  await chrome.tabs.reload(workerTabId);
  await waitForTabComplete(workerTabId);
  await sleep(6000);

  const nextLocation = await readWorkerLocationText();
  if (!isZipCodeAppliedToLocationText(nextLocation, zipCode)) {
    throw new Error(`邮编设置未生效，当前地址显示为：${nextLocation || "未知"}`);
  }

  return { changed: true };
}

async function setDeliveryZipViaEndpoint(zipCode) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: workerTabId },
    world: "MAIN",
    func: async (nextZipCode) => {
      try {
        const body = new URLSearchParams({
          locationType: "LOCATION_INPUT",
          zipCode: String(nextZipCode),
          storeContext: "generic",
          deviceType: "web",
          pageType: "Gateway",
          actionSource: "glow"
        });

        const response = await fetch("/gp/delivery/ajax/address-change.html", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "anti-csrftoken-a2z": window.CSRF_TOKEN || ""
          },
          body: body.toString(),
          credentials: "include"
        });

        if (!response.ok) {
          return { ok: false, error: `邮编接口返回 ${response.status}。` };
        }

        const payload = await response.json();
        if (!payload?.isValidAddress) {
          return { ok: false, error: "该邮编不被 Amazon 接受。" };
        }

        return { ok: true, address: payload.address || null };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
    args: [String(zipCode)]
  });

  return results?.[0]?.result || { ok: false, error: "邮编设置脚本未返回结果。" };
}

async function readWorkerLocationText() {
  const results = await chrome.scripting.executeScript({
    target: { tabId: workerTabId },
    world: "MAIN",
    func: () => (document.querySelector("#glow-ingress-line2")?.textContent || "").trim()
  });

  return String(results?.[0]?.result || "");
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`标签页 ${tabId} 加载超时。`));
    }, TAB_LOAD_TIMEOUT_MS);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }

      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function setupOffscreenDocument(path) {
  const offscreenUrl = chrome.runtime.getURL(path);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });

  if (contexts.length > 0) {
    return;
  }

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: path,
    reasons: ["DOM_PARSER", "BLOBS"],
    justification: "Keep the Amazon batch check task alive and hand large XLSX exports to the downloads API."
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function ensureTaskKeepAlive(task) {
  await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);
  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "start-keepalive",
    executionToken: Number(task.executionToken || 0),
    intervalMs: KEEPALIVE_INTERVAL_MS
  });
}

async function stopTaskKeepAlive() {
  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "stop-keepalive"
    });
  } catch (error) {
    console.debug("Unable to stop offscreen keepalive.", error);
  }
}

async function downloadBlob(bytes, filename, mimeType) {
  const blobUrl = await tryCreateBlobUrl(bytes, mimeType);
  const url = blobUrl || bytesToDataUrl(bytes, mimeType);

  return chrome.downloads.download({
    url,
    filename,
    saveAs: false
  });
}

async function tryCreateBlobUrl(bytes, mimeType) {
  try {
    await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "create-blob-url",
      base64: bytesToDataUrl(bytes, mimeType).split(",")[1] || "",
      mimeType
    });

    return response?.ok ? response.url : "";
  } catch (error) {
    console.debug("Unable to create blob url, falling back to data url.", error);
    return "";
  }
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function sleepWithPauseChecks(delayMs) {
  const endAt = Date.now() + delayMs;
  while (Date.now() < endAt) {
    if (shouldPause) {
      return true;
    }
    await sleep(Math.min(250, Math.max(0, endAt - Date.now())));
  }
  return false;
}

function validateExtractedChecks(selectedChecks, extractedChecks, html) {
  // Only the title is required. Books and other digital listings render no
  // department subnav at all, so an absent category is missing data, not a
  // failure — it is reported as a note and the row still exports.
  if (selectedChecks.title && !extractedChecks.title) {
    throw new Error("未找到标题节点。");
  }
}

// Seller, highlight, rating, bullets and images are absent on many listings
// (no Buy Box, no reviews, no A+ content), so a miss leaves the cell blank
// instead of failing the whole ASIN row.
function collectMissingFieldNotes(selectedChecks, extractedChecks) {
  const notes = [];

  if (selectedChecks.category && !extractedChecks.categoryName) {
    notes.push("无大类");
  }
  if (selectedChecks.titleHighlight && !extractedChecks.titleHighlight) {
    notes.push("无 Highlight");
  }
  if (selectedChecks.rating && !extractedChecks.ratingValue && !extractedChecks.ratingCount) {
    notes.push("无评价数据");
  }
  if (selectedChecks.bulletPoints && !extractedChecks.bulletPoints?.length) {
    notes.push("无 BP");
  }
  if (selectedChecks.imageA && !extractedChecks.imageAUrl) {
    notes.push("无 A图");
  }
  if (selectedChecks.imageDetail && !extractedChecks.imageDetailUrl) {
    notes.push("无详情图");
  }
  if (selectedChecks.seller && !extractedChecks.sellerName) {
    notes.push("无 Buy Box 卖家");
  }
  if (selectedChecks.criticalReviews && !extractedChecks.criticalReviews?.length) {
    notes.push("无差评可收集");
  }
  if (selectedChecks.stockStatus && !extractedChecks.stockStatus) {
    notes.push("无库存信息");
  }
  if (selectedChecks.deliveryPromise && !extractedChecks.deliveryPromise) {
    notes.push("无配送时效");
  }
  if (selectedChecks.fulfilmentRoute && !extractedChecks.fulfilmentRoute) {
    notes.push("无配送方式");
  }
  if (selectedChecks.addToCart && extractedChecks.hasAddToCart === false) {
    notes.push("无购物车按钮");
  }

  return notes;
}
