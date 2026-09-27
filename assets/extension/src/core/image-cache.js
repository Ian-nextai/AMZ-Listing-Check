// Image payloads are cached to avoid re-downloading a listing's images when the
// user exports twice. The cache is bounded by total base64 size because an
// unbounded one grows with the batch: at 原始尺寸 two images per ASIN is ~1MB, so
// a 50-ASIN run would pin tens of MB of base64 strings in the service worker and
// is a large part of why the task dies on a small-memory device. Evicting in
// insertion order only costs a re-download if that ASIN is exported again.
export const IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

// base64 is latin1, so one character is one byte. An entry with no payload (a
// listing whose image failed to download) is kept as a negative cache and costs
// nothing.
export function imagePayloadSize(payload) {
  return Number(payload?.base64?.length || 0);
}

export function createImageCache({ maxBytes = IMAGE_CACHE_MAX_BYTES } = {}) {
  const entries = new Map();
  let bytes = 0;

  function remove(url) {
    bytes -= imagePayloadSize(entries.get(url));
    entries.delete(url);
  }

  return {
    get: (url) => entries.get(url),
    has: (url) => entries.has(url),

    set(url, payload) {
      if (entries.has(url)) {
        remove(url);
      }

      entries.set(url, payload);
      bytes += imagePayloadSize(payload);

      while (bytes > maxBytes && entries.size > 1) {
        // The entry just added is the newest, so it is only reached once
        // everything older is gone; a single oversized payload is kept as-is.
        const oldest = entries.keys().next().value;
        if (oldest === url) {
          break;
        }
        remove(oldest);
      }
    },

    clear() {
      entries.clear();
      bytes = 0;
    },

    get bytes() {
      return bytes;
    },

    get size() {
      return entries.size;
    }
  };
}
