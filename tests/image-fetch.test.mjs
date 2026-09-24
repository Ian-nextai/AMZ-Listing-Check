import test from "node:test";
import assert from "node:assert/strict";

import {
  arrayBufferToBase64,
  computeThumbnailSize,
  downscaleImageBytes,
  fetchImageAsBase64,
  pickImageExtension
} from "../assets/extension/src/core/image-fetch.js";

test("pickImageExtension prefers the response content type", () => {
  assert.equal(pickImageExtension("image/jpeg", "https://x/a.png"), "jpg");
  assert.equal(pickImageExtension("image/png; charset=binary", "https://x/a.jpg"), "png");
  assert.equal(pickImageExtension("image/webp", ""), "webp");
});

test("pickImageExtension falls back to the url suffix", () => {
  assert.equal(pickImageExtension("", "https://m.media-amazon.com/images/I/a._AC_SL1500_.jpg"), "jpg");
  assert.equal(pickImageExtension("", "https://m.media-amazon.com/images/I/a.png?x=1"), "png");
  assert.equal(pickImageExtension("", "https://m.media-amazon.com/images/I/a"), "png");
});

test("arrayBufferToBase64 round-trips binary content", () => {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  assert.equal(arrayBufferToBase64(bytes.buffer), "AAEC/f7/");
});

test("fetchImageAsBase64 returns bytes and extension for a successful load", async () => {
  const fakeFetch = async () => ({
    ok: true,
    headers: { get: () => "image/jpeg" },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
  });

  const result = await fetchImageAsBase64("https://m.media-amazon.com/images/I/a.jpg", fakeFetch);

  assert.deepEqual(result, { base64: "AQID", extension: "jpg", byteLength: 3 });
});

test("fetchImageAsBase64 returns null for non-http urls and failed responses", async () => {
  assert.equal(await fetchImageAsBase64("data:image/png;base64,AAAA"), null);
  assert.equal(await fetchImageAsBase64(""), null);

  const notOk = async () => ({ ok: false, headers: { get: () => "" }, arrayBuffer: async () => new ArrayBuffer(0) });
  assert.equal(await fetchImageAsBase64("https://m.media-amazon.com/images/I/a.jpg", notOk), null);
});

test("fetchImageAsBase64 swallows network errors", async () => {
  const throwing = async () => {
    throw new Error("network down");
  };

  assert.equal(await fetchImageAsBase64("https://m.media-amazon.com/images/I/a.jpg", throwing), null);
});

test("computeThumbnailSize fits the longest edge inside the box", () => {
  const square = computeThumbnailSize(1500, 1500, 256);
  assert.deepEqual(square, { width: 256, height: 256, scale: 256 / 1500 });

  const landscape = computeThumbnailSize(1500, 800, 256);
  assert.equal(landscape.width, 256);
  assert.equal(landscape.height, 137);

  const portrait = computeThumbnailSize(800, 1500, 256);
  assert.equal(portrait.height, 256);
  assert.equal(portrait.width, 137);
});

test("computeThumbnailSize keeps small images at their original size", () => {
  assert.equal(computeThumbnailSize(100, 100, 256).scale, 1);
  assert.equal(computeThumbnailSize(100, 100, 256).width, 100);
});

test("computeThumbnailSize rejects unusable dimensions", () => {
  assert.equal(computeThumbnailSize(0, 100, 256), null);
  assert.equal(computeThumbnailSize(-5, 100, 256), null);
  assert.equal(computeThumbnailSize(100, 100, 0), null);
});

test("downscaleImageBytes returns null when the platform lacks canvas support", async () => {
  // Node has no createImageBitmap/OffscreenCanvas: the fetch path must fall back
  // to the untouched original instead of throwing.
  assert.equal(await downscaleImageBytes(new Uint8Array([1, 2, 3])), null);
});

test("fetchImageAsBase64 returns the original bytes when it cannot be downscaled", async () => {
  const fakeFetch = async () => ({
    ok: true,
    headers: { get: () => "image/jpeg" },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
  });

  const result = await fetchImageAsBase64("https://m.media-amazon.com/images/I/a.jpg", fakeFetch);

  assert.deepEqual(result, { base64: "AQID", extension: "jpg", byteLength: 3 });
});

test("fetchImageAsBase64 keeps the original when maxEdge is 0", async () => {
  const fakeFetch = async () => ({
    ok: true,
    headers: { get: () => "image/jpeg" },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
  });

  const result = await fetchImageAsBase64(
    "https://m.media-amazon.com/images/I/a.jpg",
    fakeFetch,
    { maxEdge: 0 }
  );

  assert.deepEqual(result, { base64: "AQID", extension: "jpg", byteLength: 3 });
});
