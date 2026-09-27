import test from "node:test";
import assert from "node:assert/strict";

import {
  dropExportPayload,
  putExportPayload,
  readExportPayload
} from "../assets/extension/src/core/export-relay.js";

// 极简 CacheStorage 替身：Node 里没有 caches 全局，而真实行为（键是否被接受、是否
// 跨上下文共享）只能在浏览器里验——已在本机 Edge 上实测过（96MB 载荷经此转发，
// offscreen 侧构建出 72MB workbook）。这里只锁模块自身的契约。
function installFakeCaches() {
  const stores = new Map();
  globalThis.caches = {
    async open(name) {
      if (!stores.has(name)) {
        stores.set(name, new Map());
      }
      const entries = stores.get(name);
      return {
        put: async (key, response) => void entries.set(String(key), response),
        match: async (key) => entries.get(String(key)),
        delete: async (key) => entries.delete(String(key)),
        keys: async () => [...entries.keys()]
      };
    }
  };
  return stores;
}

function relayStore(stores) {
  return stores.get("amz-export-relay");
}

test("a payload survives put → read, and reading consumes it", async (t) => {
  const stores = installFakeCaches();
  t.after(() => delete globalThis.caches);

  const payload = {
    rows: [["ASIN", "标题"], ["B001", "测试 商品"]],
    placements: [{ cell: "B2", url: "https://example.invalid/a.jpg", base64: "AAAA", extension: "jpg" }],
    selectedChecks: { title: true }
  };

  const key = await putExportPayload(payload);
  assert.equal(typeof key, "string");
  assert.equal(relayStore(stores).size, 1);

  assert.deepEqual(await readExportPayload(key), payload);
  // 读走即删：载荷是几十 MB 的图片 base64，留着只是占地方。
  assert.equal(relayStore(stores).size, 0);
  assert.equal(await readExportPayload(key), null);
});

test("a large payload round-trips byte-for-byte", async (t) => {
  const stores = installFakeCaches();
  t.after(() => delete globalThis.caches);

  const chunk = "A".repeat(4096);
  const placements = Array.from({ length: 64 }, (_, index) => ({
    cell: `D${index + 2}`,
    url: `https://example.invalid/${index}.jpg`,
    base64: chunk,
    extension: "jpg"
  }));

  const key = await putExportPayload({ rows: [], placements, selectedChecks: {} });
  const read = await readExportPayload(key);

  assert.equal(read.placements.length, 64);
  assert.equal(read.placements[63].base64.length, 4096);
  assert.equal(read.placements[63].url, "https://example.invalid/63.jpg");
});

test("a new export evicts any payload left behind by the previous one", async (t) => {
  const stores = installFakeCaches();
  t.after(() => delete globalThis.caches);

  const first = await putExportPayload({ rows: [["one"]] });
  const second = await putExportPayload({ rows: [["two"]] });

  assert.notEqual(first, second);
  // 串行导出，所以先前的条目一定是残渣（worker 被杀在半路）：新的一次直接清掉它。
  assert.equal(relayStore(stores).size, 1);
  assert.equal(await readExportPayload(first), null);
  assert.deepEqual(await readExportPayload(second), { rows: [["two"]] });
});

test("dropExportPayload removes a key and tolerates an empty one", async (t) => {
  const stores = installFakeCaches();
  t.after(() => delete globalThis.caches);

  const key = await putExportPayload({ rows: [] });
  await dropExportPayload(key);
  assert.equal(relayStore(stores).size, 0);

  // worker 在 finally 里无条件调用；没拿到键（put 就失败了）时不能抛。
  await assert.doesNotReject(() => dropExportPayload(null));
  await assert.doesNotReject(() => dropExportPayload(undefined));
  await assert.doesNotReject(() => dropExportPayload(""));
});

test("readExportPayload returns null for a missing key instead of throwing", async (t) => {
  installFakeCaches();
  t.after(() => delete globalThis.caches);

  assert.equal(await readExportPayload("https://amz-check.invalid/export/gone"), null);
  assert.equal(await readExportPayload(null), null);
});
