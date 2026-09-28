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

// 图片导出到表格里只占 120x120 px，抓 Amazon 原图（常见单边 1500px+）纯属浪费。
// 抓取时就地缩放，缓存里存的已是缩略图，导出无需再处理。
export const IMAGE_THUMBNAIL_MAX_EDGE = 256;
export const IMAGE_THUMBNAIL_QUALITY = 0.82;
// 0 表示不缩放，保留原图。上限防止用户填出离谱的值把内存打爆。
export const IMAGE_MAX_EDGE_LIMIT = 4096;

export function normalizeMaxImageEdge(value) {
  if (value === null || value === undefined || value === "") {
    return IMAGE_THUMBNAIL_MAX_EDGE;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return IMAGE_THUMBNAIL_MAX_EDGE;
  }

  // 0 是合法的"关闭缩放"，负值无意义。
  if (parsed <= 0) {
    return 0;
  }

  return Math.min(IMAGE_MAX_EDGE_LIMIT, Math.round(parsed));
}

// 等比缩进 maxEdge 的方框里。纯函数，不碰 canvas，可直接单测。
export function computeThumbnailSize(width, height, maxEdge = IMAGE_THUMBNAIL_MAX_EDGE) {
  const w = Number(width);
  const h = Number(height);
  const edge = Number(maxEdge);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || !Number.isFinite(edge) || edge <= 0) {
    return null;
  }

  const scale = Math.min(1, edge / Math.max(w, h));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale
  };
}

// 在支持 OffscreenCanvas 的环境（Chrome MV3 service worker）里把 oversized 的图
// 缩成 JPEG 缩略图；任何一步失败都返回 null，由调用方原样使用原图。
export async function downscaleImageBytes(
  bytes,
  { maxEdge = IMAGE_THUMBNAIL_MAX_EDGE, quality = IMAGE_THUMBNAIL_QUALITY } = {}
) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    return null;
  }

  try {
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const size = computeThumbnailSize(bitmap.width, bitmap.height, maxEdge);
    if (!size) {
      return null;
    }

    // 尺寸本来就放得下的图不重新编码，避免无谓的有损转换。
    if (size.scale === 1) {
      bitmap.close?.();
      return null;
    }

    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#ffffff"; // JPEG 无透明通道，白底兜住带透明的 PNG/WebP
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close?.();

    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    const arrayBuffer = await blob.arrayBuffer();
    if (!arrayBuffer.byteLength) {
      return null;
    }

    return {
      bytes: new Uint8Array(arrayBuffer),
      extension: "jpg",
      width: size.width,
      height: size.height,
      byteLength: arrayBuffer.byteLength
    };
  } catch (error) {
    return null;
  }
}

// Amazon 图片 CDN 有多个等价主机：同一个 /images/I/xxx.jpg 路径在任意一个上
// 返回的字节都一样（实测 images-na / images-fe 与 m.media-amazon.com 同图同字节）。
// 但 m.media-amazon.com 在部分网络会被按 SNI 阻断——TLS 握手刚发出 ClientHello
// 就收到 RST（curl exit 35 / 浏览器 fetch 报 Failed to fetch），此时换主机即可取到。
// 原主机优先（命中缓存概率最高），失败再依次回退；Amazon 页面自己也是这么分发的。
// 注意：host_permissions 里必须声明用到的每个主机，否则回退请求会被扩展拦下。
const IMAGE_CDN_HOSTS = [
  "m.media-amazon.com",
  "images-na.ssl-images-amazon.com",
  "images-fe.ssl-images-amazon.com",
  "images.amazon.com"
];

export function imageUrlCandidates(url, options = {}) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    return [];
  }

  if (options.hosts === false) {
    return [target];
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch (error) {
    return [target];
  }

  if (!IMAGE_CDN_HOSTS.includes(parsed.hostname)) {
    return [target];
  }

  // 路径与查询串原样保留，只换主机；原主机放最前（命中缓存概率最高）
  const port = parsed.port ? `:${parsed.port}` : "";
  const hosts = [parsed.hostname, ...IMAGE_CDN_HOSTS.filter((host) => host !== parsed.hostname)];
  return hosts.map((host) => `${parsed.protocol}//${host}${port}${parsed.pathname}${parsed.search}`);
}

export async function fetchImageAsBase64(url, fetchImpl = fetch, options = {}) {
  for (const candidate of imageUrlCandidates(url, options)) {
    const downloaded = await fetchOneImageAsBase64(candidate, fetchImpl, options);
    if (downloaded) {
      return downloaded;
    }
  }

  return null;
}

async function fetchOneImageAsBase64(target, fetchImpl, options = {}) {
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

    const original = {
      base64: arrayBufferToBase64(buffer),
      extension: pickImageExtension(response.headers?.get?.("content-type"), target),
      byteLength: buffer.byteLength
    };

    const maxEdge = normalizeMaxImageEdge(options.maxEdge);
    if (maxEdge === 0) {
      return original;
    }

    const thumbnail = await downscaleImageBytes(new Uint8Array(buffer), {
      maxEdge,
      quality: options.quality ?? IMAGE_THUMBNAIL_QUALITY
    });
    if (!thumbnail) {
      return original;
    }

    return {
      base64: arrayBufferToBase64(thumbnail.bytes.buffer),
      extension: thumbnail.extension,
      byteLength: thumbnail.byteLength,
      originalByteLength: original.byteLength,
      width: thumbnail.width,
      height: thumbnail.height,
      downscaled: true
    };
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
