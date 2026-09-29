// Image payloads are cached to avoid re-downloading a listing's images when the
// user exports twice. The cache is bounded by total base64 size because an
// unbounded one grows with the batch: at 原始尺寸 two images per ASIN is ~1MB, so
// a 50-ASIN run would pin tens of MB of base64 strings in the service worker and
// is a large part of why the task dies on a small-memory device. Evicting in
// insertion order only costs a re-download if that ASIN is exported again.
export const IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

// base64 is latin1, so one character is one byte. Only successful downloads may be
// stored: writing a failure (null) would create a never-expiring negative cache.
// That is not a theoretical concern — Amazon's A+ sections often reuse one store-wide
// banner, so a single transient failure on that URL poisoned every later ASIN that
// shared it and blanked whole batches of 详情图 while rows still reported success.
export function imagePayloadSize(payload) {
  return Number(payload?.base64?.length || 0);
}

// Fetch-through cache policy for one image URL. Kept here rather than in the service
// worker so the "never cache a failure" rule is covered by unit tests.
//
// `fetchImage(target)` is injected so callers decide how to download (and tests need
// no network). Returns the cached payload when present, otherwise the fresh payload
// when the download succeeds, otherwise null — with the cache left untouched on
// failure, so the next call retries instead of inheriting the error.
export async function loadImageIntoCache(cache, url, fetchImage, options = {}) {
  const target = String(url || "").trim();
  if (!target) {
    return null;
  }

  if (cache.has(target)) {
    return cache.get(target) || null;
  }

  const payload = await fetchImage(target, options);
  if (payload) {
    cache.set(target, payload);
  }

  return payload || null;
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
