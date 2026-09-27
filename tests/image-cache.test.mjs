import test from "node:test";
import assert from "node:assert/strict";

import { createImageCache, imagePayloadSize } from "../assets/extension/src/core/image-cache.js";

const img = (bytes) => ({ base64: "x".repeat(bytes), extension: "jpg" });

test("imagePayloadSize counts base64 characters and ignores empty payloads", () => {
  assert.equal(imagePayloadSize(img(40)), 40);
  assert.equal(imagePayloadSize(null), 0);
  assert.equal(imagePayloadSize(undefined), 0);
  assert.equal(imagePayloadSize({ extension: "jpg" }), 0);
});

test("the cache stores payloads and refreshes the accounting on rewrite", () => {
  const cache = createImageCache({ maxBytes: 1000 });
  cache.set("a", img(50));
  assert.equal(cache.get("a").base64.length, 50);
  assert.equal(cache.bytes, 50);
  assert.equal(cache.size, 1);

  cache.set("a", img(30));
  assert.equal(cache.size, 1);
  assert.equal(cache.bytes, 30, "rewriting a key must not double-count its bytes");
});

test("the cache evicts oldest entries once the byte budget is exceeded", () => {
  const cache = createImageCache({ maxBytes: 100 });
  cache.set("a", img(40));
  cache.set("b", img(40));
  cache.set("c", img(40));

  assert.equal(cache.has("a"), false, "the oldest entry goes first");
  assert.equal(cache.has("b"), true);
  assert.equal(cache.has("c"), true);
  assert.equal(cache.size, 2);
  assert.equal(cache.bytes, 80);
});

test("a single payload larger than the budget is still cached", () => {
  const cache = createImageCache({ maxBytes: 100 });
  cache.set("big", img(500));

  assert.equal(cache.has("big"), true, "the newest entry is never evicted");
  assert.equal(cache.bytes, 500);
});

test("evicting continues until the budget fits, and never drops the new entry", () => {
  const cache = createImageCache({ maxBytes: 100 });
  cache.set("a", img(40));
  cache.set("b", img(40));
  cache.set("c", img(90));

  assert.equal(cache.size, 1);
  assert.equal(cache.has("c"), true);
  assert.equal(cache.bytes, 90);
});

test("a failed download is kept as a zero-cost negative cache entry", () => {
  const cache = createImageCache({ maxBytes: 100 });
  cache.set("missing", null);

  assert.equal(cache.has("missing"), true, "a miss must not be retried on export");
  assert.equal(cache.get("missing"), null);
  assert.equal(cache.bytes, 0);
});

test("clear drops every entry and resets the byte count", () => {
  const cache = createImageCache({ maxBytes: 100 });
  cache.set("a", img(40));
  cache.set("b", img(40));
  assert.equal(cache.bytes, 80);

  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
  assert.equal(cache.has("a"), false);
});

// A batched runner drains the cache between chunks, so the message has to exist
// and the budget it reports has to be the one the module was built with.
function installFakeChrome() {
  const store = {};
  const listeners = [];

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
      sendMessage: async () => {},
      getURL: (path) => "chrome-extension://test/" + path,
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

test("get-status reports the cache budget and clear-image-cache drains it", async () => {
  const { send } = installFakeChrome();
  await import("../assets/extension/background.js?case=image-cache");

  const before = await send("get-status");
  assert.equal(before.memory.imageCacheBytes, 0);
  assert.equal(before.memory.imageCacheEntries, 0);
  assert.ok(before.memory.imageCacheMaxBytes > 0);

  const cleared = await send("clear-image-cache");
  assert.equal(cleared.ok, true);
  assert.equal(cleared.freedBytes, 0);
  assert.equal(cleared.freedEntries, 0);
  assert.equal(cleared.imageCacheBytes, 0);
});
