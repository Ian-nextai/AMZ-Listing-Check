const IMAGE_FETCH_TIMEOUT_MS = 15000;

export function pickImageExtension(contentType, url) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) {
    return "jpg";
  }
  if (type.includes("gif")) {
    return "gif";
  }
  if (type.includes("bmp")) {
    return "bmp";
  }
  if (type.includes("webp")) {
    return "webp";
  }
  if (type.includes("png")) {
    return "png";
  }

  const match = String(url || "").match(/\.(jpe?g|png|gif|bmp|webp)(?:\?|$)/i);
  return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "png";
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

export async function fetchImageAsBase64(url, fetchImpl = fetch) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(target, {
      signal: controller.signal,
      credentials: "omit",
      cache: "force-cache"
    });

    if (!response.ok) {
      return null;
    }

    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength) {
      return null;
    }

    return {
      base64: arrayBufferToBase64(buffer),
      extension: pickImageExtension(response.headers?.get?.("content-type"), target),
      byteLength: buffer.byteLength
    };
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
