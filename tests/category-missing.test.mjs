import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Drives the real background.js against a fake chrome API, through a complete
// ASIN cycle (tab open -> zip check -> scrape -> record).
//
// The case under test: books and other digital listings render no department
// subnav, so the "大类" (category) check finds nothing there. That is missing
// data on the listing, not a broken page — the row must still export with every
// other field intact and the category cell left blank.
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const BOOK_PAGE_HTML = fs.readFileSync(path.join(fixturesDir, "book-no-subnav.html"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fake models the handful of page-level reads the ASIN cycle performs:
// location text, page html, and the zip endpoint.
function installFakeChrome(pageHtml, { zipApplied = true } = {}) {
  const store = {};
  const listeners = [];
  const updatedListeners = [];
  let tabUrl = "";

  globalThis.chrome = {
    storage: {
      local: {
        // 真 API 的 get 接受 string | string[] | null；结果按 ASIN 分键存放后
        // 水合走的是数组形式。
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
      sendMessage: async () => ({ ok: true }),
      getURL: (p) => "chrome-extension://test/" + p,
      getContexts: async () => [],
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      lastError: null
    },
    tabs: {
      onUpdated: {
        addListener: (fn) => updatedListeners.push(fn),
        removeListener: (fn) => {
          const i = updatedListeners.indexOf(fn);
          if (i >= 0) updatedListeners.splice(i, 1);
        }
      },
      onRemoved: { addListener: () => {} },
      get: async () => ({ id: 1, url: tabUrl, status: "complete" }),
      query: async () => [],
      // A tab operation completes immediately, so the waiting code is released.
      create: async ({ url }) => {
        tabUrl = url || "";
        setTimeout(() => updatedListeners.slice().forEach((fn) => fn(1, { status: "complete" })), 0);
        return { id: 1, url: tabUrl };
      },
      update: async (_id, props) => {
        if (props?.url) tabUrl = props.url;
        setTimeout(() => updatedListeners.slice().forEach((fn) => fn(1, { status: "complete" })), 0);
        return { id: 1, url: tabUrl };
      },
      reload: async () => {
        setTimeout(() => updatedListeners.slice().forEach((fn) => fn(1, { status: "complete" })), 0);
      }
    },
    scripting: {
      executeScript: async ({ func }) => {
        const source = String(func);
        // #glow-ingress-line2 is the delivery-location read; returning the
        // requested zip means the location step is already satisfied.
        if (source.includes("glow-ingress-line2")) {
          return [{ result: zipApplied ? "New York 10010" : "" }];
        }
        if (source.includes("address-change")) {
          return [{ result: { ok: true, changed: true } }];
        }
        return [{ result: { html: pageHtml, title: "", url: tabUrl } }];
      }
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

// Collects every log line the run produces, in order.
async function runOneAsin(pageHtml, checks) {
  const { send } = installFakeChrome(pageHtml);
  const logs = [];
  const originalListener = globalThis.chrome.runtime.onMessage.addListener;

  moduleCounter += 1;
  await import(`../assets/extension/background.js?case=${moduleCounter}`);

  // background.js broadcasts its log lines to any open popup; capture them.
  globalThis.chrome.runtime.sendMessage = async (message) => {
    if (message?.type === "log" || message?.type === "log-error") {
      logs.push(`${message.type}: ${message.text}`);
    }
    return { ok: true };
  };
  void originalListener;

  await send("start-new-task", { asins: ["0735211299"], checks, delayMs: 20 });

  for (let i = 0; i < 60; i += 1) {
    await sleep(100);
    const state = await send("get-status");
    const row = state?.task?.resultsByAsin?.["0735211299"];
    if (row) return { row, state, logs };
  }

  const state = await send("get-status");
  return { row: null, state, logs };
}

let moduleCounter = 0;

test("the book fixture is a real page with no department subnav", () => {
  assert.ok(BOOK_PAGE_HTML.length > 500, "fixture should be a real captured page");
  assert.match(BOOK_PAGE_HTML, /id="productTitle"/);
  assert.equal(
    /<a[^>]*class="[^"]*\bnav-a\b[^"]*\bnav-b\b[^"]*"/i.test(BOOK_PAGE_HTML),
    false,
    "a book page renders no department store tab"
  );
});

test("a listing without a category still succeeds and keeps its other fields", async () => {
  const { row } = await runOneAsin(BOOK_PAGE_HTML, { category: true, title: true });

  assert.ok(row, "the ASIN row should have been recorded");
  // The regression: this row used to fail with "未找到大类节点。" even though
  // the title was right there in the same page.
  assert.equal(row.status, "success", `row should succeed, got error: ${row.error}`);
  assert.equal(row.error, "");
  assert.equal(row.categoryName, "");
  assert.match(row.title, /Atomic Habits/);
});

test("the missing category is reported as a note, not an error", async () => {
  const { logs } = await runOneAsin(BOOK_PAGE_HTML, { category: true, title: true });
  const text = logs.join("\n");

  assert.match(text, /无大类/);
  assert.equal(
    /未找到大类节点/.test(text),
    false,
    "an absent category must never be reported as a node failure"
  );
});

test("a listing with a category is unaffected and carries the value through", async () => {
  const inStock = fs.readFileSync(path.join(fixturesDir, "stock-in-stock.html"), "utf8");
  const { row } = await runOneAsin(inStock, { category: true, title: true });

  assert.ok(row, "the ASIN row should have been recorded");
  assert.equal(row.status, "success");
  assert.equal(row.categoryName, "Automotive");
});
