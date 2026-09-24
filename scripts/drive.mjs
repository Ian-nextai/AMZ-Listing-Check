// 驱动 Amazon Listing Check Helper 扩展：经 runner.html 页面消息路由控制 SW。
// 零 npm 依赖。Node >= 18。
// 用法: node drive.mjs <ASIN1,ASIN2,...> [选项]
//   --zip 10010        配送邮编（默认 10010）
//   --delay 1200       ASIN 间隔 ms（默认 1200）
//   --port 19222       CDP 端口（默认 19222）
//   --with-reviews     差评收集开（默认关；须先确认已登录）
//   --retry 1          失败 ASIN 自动重试次数（默认 1；0 关闭）
//   --timeout 25       总超时分钟（默认 25）
import { getBrowserWs, ws } from "./cdp.mjs";
import fs from "node:fs";

const args = process.argv.slice(2);
const ASINS = (args.find(a => !a.startsWith("--")) || "").split(",").map(s => s.trim()).filter(Boolean);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const has = (name) => args.includes(`--${name}`);
const ZIP = opt("zip", "10010");
const MAX_IMAGE_EDGE = opt("max-image-edge", "");   // 空 = 用扩展默认值
const DELAY = Number(opt("delay", "1200"));
const PORT = Number(opt("port", "19222"));
const TIMEOUT_MIN = Number(opt("timeout", "25"));
const MAX_RETRY = Number(opt("retry", "1"));

if (!ASINS.length) {
  console.error("用法: node drive.mjs <ASIN1,...> [--zip N] [--delay N] [--port N] [--with-reviews] [--retry N] [--timeout min] [--max-image-edge N]");
  process.exit(1);
}

const CHECKS = {
  title: true, titleHighlight: true, rating: true, bulletPoints: true,
  imageA: true, imageDetail: true, category: true, addToCart: true,
  seller: true,
  criticalReviews: has("with-reviews"),
  stockStatus: true, deliveryPromise: true, fulfilmentRoute: true
};

const browserWs = await getBrowserWs(PORT);
const c = await ws(browserWs);
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, m);

const crypto = await import("node:crypto");
const fsMod = await import("node:fs");
// 从 manifest 的固定 key 推导扩展 ID（sha256 前 16 字节 → mpdecimal），避免把
// Hangouts 等内置组件扩展（同样以 chrome-extension:// 开头）误认成目标
function extensionIdFromKey(manifestPath) {
  try {
    const key = JSON.parse(fsMod.readFileSync(manifestPath, "utf8")).key;
    if (!key) return "";
    const h = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
    return [...h].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join("");
  } catch { return ""; }
}
const EXT_DIR = new URL("../assets/extension/", import.meta.url).pathname;
const EXT_ID = extensionIdFromKey(`${EXT_DIR}manifest.json`);

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

// 跑一轮任务并等到 completed；返回 task 快照
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

async function runTask(asins, label) {
  const start = await sendToBg(buildStartPayload(asins));
  if (!start?.ok) throw new Error(`start-new-task 失败: ${JSON.stringify(start)}`);
  log(`${label}: ${asins.length} ASINs 开始（差评${CHECKS.criticalReviews ? "开" : "关"}）`);

  const t0 = Date.now();
  let lastLine = "";
  while (Date.now() - t0 < TIMEOUT_MIN * 60 * 1000) {
    await new Promise(r => setTimeout(r, 3000));
    const st = await sendToBg({ type: "get-status" });
    const task = st?.task;
    const line = `${st?.status} | ${task?.processedAsins?.length ?? 0}/${task?.allAsins?.length ?? "?"} | cur=${task?.currentAsin || "-"} | ${(task?.progressText || "").slice(0, 70)}`;
    if (line !== lastLine) { log(`${label} ${line}`); lastLine = line; }
    if (st?.status === "completed" || st?.status === "idle") break;
  }
  const st = await sendToBg({ type: "get-status" });
  if (st?.status !== "completed") throw new Error(`任务未完成: ${st?.status}`);
  return st.task;
}

const row = (r) => ({
  asin: r.asin, status: r.status,
  title: (r.title || "").slice(0, 60),
  rating: r.ratingValue || "", reviews: r.ratingCount || "",
  seller: r.sellerName || "", stock: r.stockStatus || ""
});

// ---- 主任务 ----
const mainTask = await runTask(ASINS, "[主]");
const mainResults = Object.values(mainTask.resultsByAsin || {});
let rows = mainResults.map(row);
let retried = 0;
let retryTask = null;

// ---- 失败重试 ----
const failedAsins = mainResults.filter(r => r.status === "failed").map(r => r.asin);
if (failedAsins.length && MAX_RETRY > 0) {
  log(`[重试] 自动补跑 ${failedAsins.length} 个失败 ASIN: ${failedAsins.join(",")}`);
  await new Promise(r => setTimeout(r, 3000));
  retryTask = await runTask(failedAsins, "[重试]");
  const retryResults = Object.values(retryTask.resultsByAsin || {});
  const retryMap = new Map(retryResults.map(r => [r.asin, r]));
  rows = rows.map(r => {
    const again = retryMap.get(r.asin);
    return again && again.status === "success" ? (retried++, row(again)) : again ? row(again) : r;
  });
}

const success = rows.filter(r => r.status === "success").length;
const failed = rows.filter(r => r.status === "failed").length;
const report = {
  ok: success > 0,
  status: "completed",
  zip: ZIP,
  reviewsEnabled: CHECKS.criticalReviews,
  maxImageEdge: MAX_IMAGE_EDGE === "" ? null : Number(MAX_IMAGE_EDGE),
  asins: ASINS,
  mainXlsx: mainTask.downloadFilename || "",
  retryXlsx: retryTask?.downloadFilename || "",
  retriedSuccess: retried,
  success, failed,
  failures: rows.filter(r => r.status === "failed").map(r => `${r.asin}: ${(r.error || "").slice(0, 120)}`),
  rows
};
fs.writeFileSync("/tmp/amz-last-run.json", JSON.stringify(report, null, 2));
console.log("\n=== FINAL ===");
console.log(JSON.stringify({ ...report, rows: report.rows.slice(0, 8) }, null, 2));
console.log("REPORT=/tmp/amz-last-run.json");
c.close();
