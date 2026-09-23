import test from "node:test";
import assert from "node:assert/strict";

// Drives the real background.js against a fake chrome API to cover the
// start -> discard -> start sequence the task loop has to survive.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function installFakeChrome() {
  const store = {};
  const listeners = [];

  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: store[key] }),
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
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onRemoved: { addListener: () => {} },
      get: async () => ({ id: 1, url: "https://www.amazon.com/dp/X", status: "complete" }),
      query: async () => [],
      create: async () => ({ id: 1 }),
      update: async () => ({ id: 1 }),
      reload: async () => {}
    },
    scripting: {
      executeScript: async () => [{ result: { html: "<html></html>", title: "", url: "" } }]
    },
    offscreen: { createDocument: async () => {} },
    downloads: { download: async () => 1 },
    windows: { update: async () => {} }
  };

  return {
    send: (type, extra = {}) =>
      new Promise((resolve) => {
        for (const listener of listeners) {
          if (listener({ type, ...extra }, {}, resolve) === true) return;
        }
        resolve(undefined);
      })
  };
}

// Fresh module instance per test so the module-level run state starts clean.
let moduleCounter = 0;
async function loadBackground() {
  moduleCounter += 1;
  return import(`../assets/extension/background.js?case=${moduleCounter}`);
}

const ASINS = ["B0CKWX6W1L", "B00FRRXO0Y", "B0D1XD1ZV3"];

test("a new task can start immediately after discarding a running one", async () => {
  const { send } = installFakeChrome();
  await loadBackground();

  const first = await send("start-new-task", { asins: ASINS, checks: { title: true }, delayMs: 200 });
  assert.equal(first.ok, true);
  await sleep(250);

  const discard = await send("discard-task");
  assert.equal(discard.ok, true);

  // The regression: this used to be rejected with "已有任务在运行。"
  const second = await send("start-new-task", { asins: ["B0FK27RC39"], checks: { title: true }, delayMs: 200 });
  assert.equal(second.ok, true, "starting a task right after discard must be accepted");
  await sleep(250);

  const state = await send("get-status");
  assert.equal(state.status, "running");
  assert.deepEqual(state.task.allAsins, ["B0FK27RC39"]);
});

test("an abandoned run cannot overwrite the task that replaced it", async () => {
  const { send } = installFakeChrome();
  await loadBackground();

  await send("start-new-task", { asins: ASINS, checks: { title: true }, delayMs: 200 });
  await sleep(250);
  await send("discard-task");

  await send("start-new-task", { asins: ["B0BSHF7WHW"], checks: { title: true }, delayMs: 200 });
  await sleep(250);

  // Give the abandoned loop time to finish its in-flight ASIN and try to write.
  await sleep(3000);

  const state = await send("get-status");
  assert.deepEqual(state.task.allAsins, ["B0BSHF7WHW"]);
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
