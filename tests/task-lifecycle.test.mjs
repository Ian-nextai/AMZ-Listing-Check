import test from "node:test";
import assert from "node:assert/strict";

// Drives the real background.js against a fake chrome API to cover the
// start -> discard -> start sequence the task loop has to survive.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// drivable=true 时这个 fake 会像真浏览器那样触发 tabs.onUpdated，让标签页加载
// 完成、ASIN 走完一整轮。默认不触发：上面那几个生命周期用例正需要运行一直停在
// 「进行中」，好观察中途的写入。
function installFakeChrome({ drivable = false, pageHtml = "<html></html>" } = {}) {
  const store = {};
  const listeners = [];
  const updatedListeners = [];
  let tabUrl = "https://www.amazon.com/dp/X";
  const settle = () => {
    if (!drivable) return;
    setTimeout(() => updatedListeners.slice().forEach((fn) => fn(1, { status: "complete" })), 0);
  };

  globalThis.chrome = {
    storage: {
      local: {
        // 真 API 的 get 接受 string | string[] | null；结果按 ASIN 分键存放后
        // 水合走的是数组形式，getKeys 走的是 null 形式，都要支持。
        get: async (keys) => {
          if (keys === null || keys === undefined) return { ...store };
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) out[key] = store[key];
          return out;
        },
        getKeys: async () => Object.keys(store),
        set: async (obj) => Object.assign(store, obj),
        remove: async (keys) => {
          for (const key of [].concat(keys)) delete store[key];
        }
      }
    },
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async () => {},
      getURL: (p) => "chrome-extension://test/" + p,
      getContexts: async () => [],
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} }
    },
    tabs: {
      onUpdated: {
        addListener: (fn) => updatedListeners.push(fn),
        removeListener: (fn) => {
          const index = updatedListeners.indexOf(fn);
          if (index >= 0) updatedListeners.splice(index, 1);
        }
      },
      onRemoved: { addListener: () => {} },
      get: async () => ({ id: 1, url: tabUrl, status: "complete" }),
      query: async () => [],
      create: async ({ url } = {}) => {
        tabUrl = url || "";
        settle();
        return { id: 1, url: tabUrl };
      },
      update: async (_id, props) => {
        if (props?.url) tabUrl = props.url;
        settle();
        return { id: 1, url: tabUrl };
      },
      reload: async () => {
        settle();
      }
    },
    scripting: {
      executeScript: async () => [{ result: { html: pageHtml, title: "", url: "" } }]
    },
    offscreen: { createDocument: async () => {} },
    downloads: { download: async () => 1 },
    windows: { update: async () => {} }
  };

  return {
    store,
    send: (type, extra = {}) =>
      new Promise((resolve) => {
        for (const listener of listeners) {
          if (listener({ type, ...extra }, {}, resolve) === true) return;
        }
        resolve(undefined);
      })
  };
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error("waitFor 超时");
}

// Fresh module instance per test so the module-level run state starts clean.
let moduleCounter = 0;
async function loadBackground() {
  moduleCounter += 1;
  return import(`../assets/extension/background.js?case=${moduleCounter}`);
}

const ASINS = ["B07FZ8S74R", "B09B8V1LZ3", "B08KTZ8249"];

test("a new task can start immediately after discarding a running one", async () => {
  const { send } = installFakeChrome();
  await loadBackground();

  const first = await send("start-new-task", { asins: ASINS, checks: { title: true }, delayMs: 200 });
  assert.equal(first.ok, true);
  await sleep(250);

  const discard = await send("discard-task");
  assert.equal(discard.ok, true);

  // The regression: this used to be rejected with "已有任务在运行。"
  const second = await send("start-new-task", { asins: ["B0D1XD1ZV3"], checks: { title: true }, delayMs: 200 });
  assert.equal(second.ok, true, "starting a task right after discard must be accepted");
  await sleep(250);

  const state = await send("get-status");
  assert.equal(state.status, "running");
  assert.deepEqual(state.task.allAsins, ["B0D1XD1ZV3"]);
});

test("an abandoned run cannot overwrite the task that replaced it", async () => {
  const { send } = installFakeChrome();
  await loadBackground();

  await send("start-new-task", { asins: ASINS, checks: { title: true }, delayMs: 200 });
  await sleep(250);
  await send("discard-task");

  await send("start-new-task", { asins: ["B0D1XD1ZV3"], checks: { title: true }, delayMs: 200 });
  await sleep(250);

  // Give the abandoned loop time to finish its in-flight ASIN and try to write.
  await sleep(3000);

  const state = await send("get-status");
  assert.deepEqual(state.task.allAsins, ["B0D1XD1ZV3"]);
  assert.equal(state.status, "running");
});

test("a discarded task is not resumed by a runner heartbeat", async () => {
  const { send } = installFakeChrome();
  await loadBackground();

  await send("start-new-task", { asins: ASINS, checks: { title: true }, delayMs: 200 });
  await sleep(250);
  await send("discard-task");
  await sleep(200);

  const heartbeat = await send("runner-heartbeat");
  assert.equal(heartbeat.activeTask, false, "a discarded task must not report as active");
  await sleep(250);

  const state = await send("get-status");
  assert.equal(state.status, "idle");
  assert.equal(state.task, null);
});

test("discard clears the stored task and returns the popup to idle", async () => {
  const { send } = installFakeChrome();
  await loadBackground();

  await send("start-new-task", { asins: ASINS, checks: { title: true }, delayMs: 200 });
  await sleep(250);
  await send("discard-task");
  await sleep(200);

  const state = await send("get-status");
  assert.equal(state.status, "idle");
  assert.equal(state.task, null);
});

test("discard leaves no stale progress behind", async () => {
  const { send } = installFakeChrome();
  await loadBackground();

  await send("start-new-task", { asins: ASINS, checks: { title: true }, delayMs: 200 });
  await sleep(300);

  // A run in flight has written progress by now.
  const during = await send("get-status");
  assert.equal(during.status, "running");

  await send("discard-task");
  // Wait long enough for the abandoned run to reach its next checkpoint and
  // attempt a write.
  await sleep(2500);

  const after = await send("get-status");
  assert.equal(after.status, "idle", "status must settle on idle after discard");
  assert.equal(after.progress, "", "stale progress text must not survive a discard");
  assert.equal(after.task, null);

  // The discard notice itself is expected; what must not appear is any further
  // progress from the abandoned run.
  const texts = after.history.map((entry) => entry.text);
  assert.ok(texts.every((text) => !/正在处理|开始抓取 ASIN/.test(text)),
    "the abandoned run must not keep logging progress");
});

// ---- 存储拆分：header 键 + 每 ASIN 一个结果键 ----

const RESULT_PREFIX = "amzResult:";
const resultKeysOf = (store) => Object.keys(store).filter((key) => key.startsWith(RESULT_PREFIX));
// 只要标题节点够 extractAmazonListingChecks 记一条成功结果
const STUB_PAGE = '<html><body><span id="productTitle">Storage Split Listing</span></body></html>';

test("results live in per-ASIN keys while the header stays result-free", async () => {
  const { send, store } = installFakeChrome({ drivable: true, pageHtml: STUB_PAGE });
  await loadBackground();

  await send("start-new-task", { asins: ASINS, checks: { title: true }, delayMs: 200 });
  await waitFor(() => store.task?.processedAsins?.length >= 1);

  assert.equal(store.task.resultsByAsin, undefined, "header must not carry result bodies");

  assert.deepEqual(resultKeysOf(store), [`${RESULT_PREFIX}${ASINS[0]}`]);
  const stored = store[`${RESULT_PREFIX}${ASINS[0]}`];
  assert.equal(stored.asin, ASINS[0]);
  assert.equal(stored.status, "success");
  assert.match(stored.title, /Storage Split Listing/);

  // 读取方看到的仍是完整 task：水合只发生在 loadTaskFromStorage 这一个边界上。
  const state = await send("get-status");
  assert.deepEqual(Object.keys(state.task.resultsByAsin), [ASINS[0]]);
  assert.equal(state.task.resultsByAsin[ASINS[0]].status, "success");

  await send("discard-task");
});

test("polling without results returns the header alone", async () => {
  const { send, store } = installFakeChrome({ drivable: true, pageHtml: STUB_PAGE });
  await loadBackground();

  await send("start-new-task", { asins: ASINS, checks: { title: true }, delayMs: 200 });
  await waitFor(() => store.task?.processedAsins?.length >= 1);

  const light = await send("get-status", { includeResults: false });
  assert.equal(light.task.resultsByAsin, undefined);
  assert.deepEqual(light.task.processedAsins, [ASINS[0]]);
  assert.deepEqual(light.task.allAsins, ASINS);

  await send("discard-task");
});

test("discarding a task drops every result key", async () => {
  const { send, store } = installFakeChrome({ drivable: true });
  await loadBackground();

  await send("start-new-task", { asins: ASINS, checks: { title: true }, delayMs: 200 });
  await waitFor(() => store.task?.processedAsins?.length >= 1);
  await send("discard-task");
  await waitFor(() => store.task === undefined);

  assert.deepEqual(resultKeysOf(store), [], "discard must drop every result key");
});

test("starting a task right after a finished one purges its result keys", async () => {
  const { send, store } = installFakeChrome({ drivable: true });
  await loadBackground();

  await send("start-new-task", { asins: ASINS, checks: { title: true }, delayMs: 50 });
  await waitFor(async () => (await send("get-status")).status === "completed", 20000);
  assert.ok(resultKeysOf(store).length > 0, "a finished run must have written result keys");

  // 这条路径不经过 clearTask —— 它只覆盖 task 键，不清前缀键。
  await send("start-new-task", { asins: ["B0D1XD1ZV3"], checks: { title: true }, delayMs: 50 });

  const stale = ASINS.map((asin) => `${RESULT_PREFIX}${asin}`);
  assert.deepEqual(resultKeysOf(store).filter((key) => stale.includes(key)), [],
    "the previous run's results must not survive into the new task");

  await send("discard-task");
});
