// 驱动 Amazon Listing Check Helper 扩展：经 runner.html 页面消息路由控制 SW。
// 零 npm 依赖。Node >= 18。
// 用法: node drive.mjs <ASIN1,ASIN2,...> [选项]
//   --zip 10010        配送邮编（默认 10010）
//   --delay 1200       ASIN 间隔 ms（默认 1200）
//   --port 19222       CDP 端口（默认 19222）
//   --with-reviews     差评收集开（默认关；须先确认已登录）
//   --retry 1          失败 ASIN 自动重试次数（默认 1；0 关闭）
//   --chunk 8          每批 ASIN 数（默认 0=不分批）；批间清空扩展图片缓存
//   --timeout 25       单批总超时分钟（默认 25）
import { getBrowserWs, ws } from "./cdp.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const ASINS = (args.find(a => !a.startsWith("--")) || "").split(",").map(s => s.trim()).filter(Boolean);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const has = (name) => args.includes(`--${name}`);
// 低内存设备上图片是最大的一笔开销：抓图要额外下载并解码，导出时
// 又要把 base64 塞进工作簿。--no-images 只留文本列。
const NO_IMAGES = has("no-images");
const ZIP = opt("zip", "10010");
const MAX_IMAGE_EDGE = opt("max-image-edge", "");   // 空 = 用扩展默认值
const DELAY = Number(opt("delay", "1200"));
const PORT = Number(opt("port", "19222"));
const TIMEOUT_MIN = Number(opt("timeout", "25"));
const MAX_RETRY = Number(opt("retry", "1"));
const CHUNK = Number(opt("chunk", "0"));

if (!ASINS.length) {
  console.error("用法: node drive.mjs <ASIN1,...> [--zip N] [--delay N] [--port N] [--with-reviews] [--retry N] [--chunk N] [--timeout min] [--max-image-edge N]");
  process.exit(1);
}

const CHECKS = {
  title: true, titleHighlight: true, rating: true, bulletPoints: true,
  price: true, coupon: true, discount: true,
  imageA: !NO_IMAGES, imageDetail: !NO_IMAGES, category: true, addToCart: true,
  seller: true, fitment: true,
  criticalReviews: has("with-reviews"),
  stockStatus: true, deliveryPromise: true, fulfilmentRoute: true
};

const browserWs = await getBrowserWs(PORT);
const c = await ws(browserWs);
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, m);

const crypto = await import("node:crypto");
// 从 manifest 的固定 key 推导扩展 ID（sha256 前 16 字节 → mpdecimal），避免把
// Hangouts 等内置组件扩展（同样以 chrome-extension:// 开头）误认成目标
function extensionIdFromKey(manifestPath) {
  try {
    const key = JSON.parse(fs.readFileSync(manifestPath, "utf8")).key;
    if (!key) return "";
    const h = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
    return [...h].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join("");
  } catch { return ""; }
}
// fileURLToPath 而非 URL.pathname：Windows 上 pathname 会给出 /D:/... 这种
// 前导斜杠的路径，fs 和 chrome 都不认。此处不能写死分隔符。
const EXT_DIR = fileURLToPath(new URL("../assets/extension/", import.meta.url));
const EXT_ID = extensionIdFromKey(path.join(EXT_DIR, "manifest.json"));

// 定位/唤醒 runner 页
let { targetInfos } = await c.send("Target.getTargets");
let runner = targetInfos.find(t => t.url.includes("runner.html") && !t.url.includes("admccjkmock")
  && (!EXT_ID || t.url.includes(EXT_ID)));
if (!runner && EXT_ID) {
  // 固定 ID 已知：直接开 runner.html（Chrome 153 的 Target.createTarget 会走 internal redirect）
  await c.send("Target.createTarget", { url: `chrome-extension://${EXT_ID}/runner.html` });
  await new Promise(r => setTimeout(r, 4000));
  ({ targetInfos } = await c.send("Target.getTargets"));
  runner = targetInfos.find(t => t.url.includes(`${EXT_ID}/runner.html`));
}
if (!runner) {
  const extPage = targetInfos.find(t => t.url.startsWith("chrome-extension://") && !t.url.includes("admccjkmock"));
  if (extPage) {
    const id = extPage.url.split("/")[2];
    await c.send("Target.createTarget", { url: `chrome-extension://${id}/runner.html` });
    await new Promise(r => setTimeout(r, 4000));
    ({ targetInfos } = await c.send("Target.getTargets"));
    runner = targetInfos.find(t => t.url.includes(`${id}/runner.html`));
  }
}
if (!runner) { console.error("runner 页不可用（扩展未加载？跑 setup.sh 诊断）"); process.exit(1); }

const { sessionId } = await c.send("Target.attachToTarget", { targetId: runner.targetId, flatten: true });
const sendToBg = (msg) => c.sendSession(sessionId, "Runtime.evaluate", {
  expression: `new Promise(res => chrome.runtime.sendMessage(${JSON.stringify(msg)}, r => res(r)))`,
  awaitPromise: true, returnByValue: true
}).then(r => {
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || "").slice(0, 400));
  return r.result?.value;
});

// 跑一轮任务并等到 completed；返回 { task, peakMemory }
// 未指定 --max-image-edge 时不带该字段，让扩展用 popup 里用户选的默认值
function buildStartPayload(asins) {
  const payload = {
    type: "start-new-task",
    asins,
    checks: CHECKS,
    zipCode: ZIP,
    delayMs: DELAY
  };
  if (MAX_IMAGE_EDGE !== "") {
    payload.maxImageEdge = Number(MAX_IMAGE_EDGE);
  }
  return payload;
}

const mb = (bytes) => `${(Number(bytes || 0) / 1048576).toFixed(1)}MB`;
// downloadPath 是这次导出优化的验收信号：dataurl 说明 offscreen 的二进制传输
// 退化了，大 workbook 会在那里堆出上百 MB 的瞬时字符串
const sizeText = (info) =>
  info ? `${(Number(info.bytes || 0) / 1048576).toFixed(2)}MB via ${info.downloadPath}` : "导出信息缺失";

async function runTask(asins, label) {
  const start = await sendToBg(buildStartPayload(asins));
  if (!start?.ok) throw new Error(`start-new-task 失败: ${JSON.stringify(start)}`);
  log(`${label}: ${asins.length} ASINs 开始（差评${CHECKS.criticalReviews ? "开" : "关"}）`);

  const t0 = Date.now();
  let lastLine = "";
  let peakMemory = null;
  let exportInfo = null;
  while (Date.now() - t0 < TIMEOUT_MIN * 60 * 1000) {
    await new Promise(r => setTimeout(r, 3000));
    // includeResults:false —— 轮询只要计数和当前 ASIN。带上完整结果正文的话，
    // 每 3 秒都要把几十个 ASIN 的评论正文克隆过 CDP 一遍。
    const st = await sendToBg({ type: "get-status", includeResults: false });
    const task = st?.task;
    if (st?.memory && (!peakMemory || st.memory.imageCacheBytes > peakMemory.imageCacheBytes)) {
      peakMemory = st.memory;
    }
    if (st?.export) exportInfo = st.export;
    const line = `${st?.status} | ${task?.processedAsins?.length ?? 0}/${task?.allAsins?.length ?? "?"} | cur=${task?.currentAsin || "-"} | ${(task?.progressText || "").slice(0, 70)}`;
    if (line !== lastLine) { log(`${label} ${line}`); lastLine = line; }
    if (st?.status === "completed" || st?.status === "idle") break;
  }
  const st = await sendToBg({ type: "get-status" });
  if (st?.export) exportInfo = st.export;
  if (st?.status !== "completed") throw new Error(`任务未完成: ${st?.status}`);
  return { task: st.task, peakMemory: peakMemory || st.memory || null, exportInfo };
}

// 批间清空扩展的图片缓存：这是唯一随批次线性增长的内存，不清的话分片只解决
// 一半问题（导出峰值降了，但 base64 仍全量堆在 service worker 里）。
async function drainImageCache(label) {
  try {
    const r = await sendToBg({ type: "clear-image-cache" });
    if (r?.ok) {
      log(`${label} 清空图片缓存：释放 ${mb(r.freedBytes)} / ${r.freedEntries} 张`);
    } else {
      log(`${label} 清空图片缓存被拒（${r?.error || "未知原因"}），忽略`);
    }
  } catch (error) {
    log(`${label} 清空图片缓存失败（忽略）: ${error.message}`);
  }
}

function chunkAsins(list, size) {
  if (!(size > 0)) return [list];
  const batches = [];
  for (let i = 0; i < list.length; i += size) batches.push(list.slice(i, i + size));
  return batches;
}

const row = (r) => ({
  asin: r.asin, status: r.status,
  title: (r.title || "").slice(0, 60),
  rating: r.ratingValue || "", reviews: r.ratingCount || "",
  price: r.price || "", coupon: r.coupon || "", discount: r.discount || "",
  seller: r.sellerName || "", stock: r.stockStatus || ""
});

// ---- 主任务（按 --chunk 分批，批间清空扩展图片缓存）----
const batches = chunkAsins(ASINS, CHUNK);
const rows = [];
const allResults = [];
const xlsxFiles = [];
let retried = 0;
let peakImageCache = null;
let lastExport = null;

for (let index = 0; index < batches.length; index += 1) {
  const batch = batches[index];
  const tag = batches.length > 1 ? `[批${index + 1}/${batches.length}]` : "[主]";
  const { task, peakMemory, exportInfo } = await runTask(batch, tag);
  if (exportInfo) lastExport = exportInfo;

  if (peakMemory && (!peakImageCache || peakMemory.imageCacheBytes > peakImageCache.imageCacheBytes)) {
    peakImageCache = peakMemory;
  }
  if (task.downloadFilename) xlsxFiles.push(task.downloadFilename);
  log(`${tag} 导出 ${task.downloadFilename || "(无)"}，${sizeText(exportInfo)}，图片缓存峰值 ${mb(peakMemory?.imageCacheBytes)}`);

  const byAsin = new Map(Object.values(task.resultsByAsin || {}).map(r => [r.asin, r]));

  // ---- 失败重试：只在批内补跑，失败者不会把整批拖回去重来 ----
  const failedAsins = batch.filter(a => byAsin.get(a)?.status === "failed");
  if (failedAsins.length && MAX_RETRY > 0) {
    log(`${tag} 自动补跑 ${failedAsins.length} 个失败 ASIN: ${failedAsins.join(",")}`);
    await new Promise(r => setTimeout(r, 3000));
    const retry = await runTask(failedAsins, `${tag}重试`);
    if (retry.exportInfo) lastExport = retry.exportInfo;
    if (retry.task.downloadFilename) xlsxFiles.push(retry.task.downloadFilename);
    for (const result of Object.values(retry.task.resultsByAsin || {})) {
      if (result.status === "success") { byAsin.set(result.asin, result); retried += 1; }
    }
  }

  for (const asin of batch) {
    const result = byAsin.get(asin);
    if (!result) continue;
    allResults.push(result);
    rows.push(row(result));
  }

  if (index < batches.length - 1) await drainImageCache(tag);
}

const success = rows.filter(r => r.status === "success").length;
const failed = rows.filter(r => r.status === "failed").length;
const report = {
  ok: success > 0,
  status: "completed",
  zip: ZIP,
  reviewsEnabled: CHECKS.criticalReviews,
  maxImageEdge: MAX_IMAGE_EDGE === "" ? null : Number(MAX_IMAGE_EDGE),
  chunkSize: CHUNK > 0 ? CHUNK : 0,
  asins: ASINS,
  mainXlsx: xlsxFiles[0] || "",
  xlsxFiles,
  peakImageCacheBytes: peakImageCache?.imageCacheBytes ?? null,
  export: lastExport,
  retriedSuccess: retried,
  success, failed,
  failures: allResults.filter(r => r.status === "failed").map(r => `${r.asin}: ${(r.error || "").slice(0, 120)}`),
  rows
};
// os.tmpdir() 而非写死 /tmp：Windows 上没有 /tmp
const REPORT_PATH = path.join(os.tmpdir(), "amz-last-run.json");
fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
console.log("\n=== FINAL ===");
console.log(JSON.stringify({ ...report, rows: report.rows.slice(0, 8) }, null, 2));
console.log(`REPORT=${REPORT_PATH}`);
c.close();
