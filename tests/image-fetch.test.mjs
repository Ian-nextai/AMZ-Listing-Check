import test from "node:test";
import assert from "node:assert/strict";

import {
  arrayBufferToBase64,
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
