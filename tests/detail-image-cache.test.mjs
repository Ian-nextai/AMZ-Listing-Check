// 回归测试：图片缓存绝不能把「下载失败」也缓存起来。
//
// 曾经的实现（background.js fetchListingImage）：
//   if (!imageCache.has(target)) imageCache.set(target, await fetchImage...);
//   return imageCache.get(target);
// 失败返回 null 也照样 set 进缓存，形成永不失效的负缓存。Amazon 的 A+ 详情图里
// 常有一张全店共用的 banner，于是某次瞬时抖动就让之后每个 ASIN 的同一 URL 都命中
// null：405 个 ASIN 的批量抓取里详情图只有 49.8% 拿到，A图 却 808/808 全满，
// 且缺失行的 status 仍是 success（静默）。
import test from "node:test";
import assert from "node:assert/strict";

import { createImageCache, loadImageIntoCache } from "../assets/extension/src/core/image-cache.js";

const PAYLOAD = { base64: "AQID", extension: "jpg", byteLength: 3 };

test("loadImageIntoCache returns and caches a successful download", async () => {
  const cache = createImageCache();
  let calls = 0;
  const fetchImage = async () => {
    calls += 1;
    return PAYLOAD;
  };

  assert.deepEqual(await loadImageIntoCache(cache, "https://m.media-amazon.com/a.jpg", fetchImage), PAYLOAD);
  assert.equal(cache.has("https://m.media-amazon.com/a.jpg"), true);

  // 第二次走缓存，不再下载
  assert.deepEqual(await loadImageIntoCache(cache, "https://m.media-amazon.com/a.jpg", fetchImage), PAYLOAD);
  assert.equal(calls, 1);
});

test("loadImageIntoCache leaves the cache empty when the download fails", async () => {
  const cache = createImageCache();
  const fetchImage = async () => null;

  assert.equal(await loadImageIntoCache(cache, "https://m.media-amazon.com/a.jpg", fetchImage), null);
  assert.equal(cache.has("https://m.media-amazon.com/a.jpg"), false);
  assert.equal(cache.size, 0);
});

test("a single transient failure does not poison later ASINs sharing one banner URL", async () => {
  // 全店共用的 A+ banner：所有 ASIN 的详情图都是同一个 URL
  const shared = "https://m.media-amazon.com/images/S/aplus-media-library-service-media/shared-banner.jpg";
  const cache = createImageCache();
  let attempt = 0;
  const fetchImage = async () => {
    attempt += 1;
    return attempt === 1 ? null : PAYLOAD; // 第一次抖动，之后恢复
  };

  // ASIN 1：抖动，失败
  assert.equal(await loadImageIntoCache(cache, shared, fetchImage), null);
  // ASIN 2：同一 URL 必须重新尝试，而不是继承上一次的失败
  assert.deepEqual(await loadImageIntoCache(cache, shared, fetchImage), PAYLOAD);
  assert.equal(attempt, 2);
  // ASIN 3：此时已成功缓存，直接复用
  assert.deepEqual(await loadImageIntoCache(cache, shared, fetchImage), PAYLOAD);
  assert.equal(attempt, 2);
});

test("loadImageIntoCache swallows a throwing download without caching anything", async () => {
  const cache = createImageCache();
  const fetchImage = async () => {
    throw new TypeError("Failed to fetch");
  };

  await assert.rejects(() => loadImageIntoCache(cache, "https://m.media-amazon.com/a.jpg", fetchImage));
  assert.equal(cache.size, 0);
});

test("loadImageIntoCache ignores empty urls and never calls the downloader", async () => {
  const cache = createImageCache();
  let calls = 0;
  const fetchImage = async () => {
    calls += 1;
    return PAYLOAD;
  };

  assert.equal(await loadImageIntoCache(cache, "", fetchImage), null);
  assert.equal(await loadImageIntoCache(cache, "   ", fetchImage), null);
  assert.equal(calls, 0);
  assert.equal(cache.size, 0);
});

test("loadImageIntoCache tolerates a falsy entry left in the cache", async () => {
  // 万一有别的调用方写进了 falsy 值，也不能把它当成有效载荷返回 undefined
  const cache = createImageCache();
  cache.set("https://m.media-amazon.com/a.jpg", null);

  assert.equal(await loadImageIntoCache(cache, "https://m.media-amazon.com/a.jpg", async () => PAYLOAD), null);
});
