// 导出载荷（行数据 + 所有图片的 base64）不能直接塞进扩展消息：消息是 JSON，且有
// 尺寸上限（量级 64MB），而载荷正好和图片缓存的上限同量级，大批量 + 大图设置下会
// 顶到。Cache Storage 在 service worker 和 offscreen 文档里都能读写，也没有这个
// 上限，所以往那儿转存一次，跨上下文只传一个键名。
const RELAY_CACHE = "amz-export-relay";

// 键带时间戳和随机串：同一 profile 下先后两次导出（或批间重试）不该撞车。
// 用 https 的保留域名而不是 chrome-extension:// —— 它只是个键，永远不会被 fetch，
// 而 Cache Storage 对键的 scheme 有要求，http(s) 是肯定被接受的。
function buildRelayKey() {
  return `https://amz-check.invalid/export/${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function putExportPayload(payload) {
  const cache = await caches.open(RELAY_CACHE);
  // 导出是串行的（收尾那一次），所以这次 put 之前还在的条目必然是残渣：上一次导出要么
  // 正常收尾（自己删了），要么 service worker 被硬杀在半路。留着就是几十 MB 的图片
  // base64 永久占着 Cache Storage，顺手清掉，让缓存里最多只有一份载荷。
  for (const stale of await cache.keys()) {
    await cache.delete(stale);
  }

  const key = buildRelayKey();
  await cache.put(
    key,
    new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } })
  );
  return key;
}

// worker 在拿到 offscreen 的回复后调用，成功失败都要清 —— 载荷是几十 MB 的图片
// base64，留着只是占地方。
export async function dropExportPayload(key) {
  if (!key) {
    return;
  }

  try {
    const cache = await caches.open(RELAY_CACHE);
    await cache.delete(key);
  } catch (error) {
    console.debug("Unable to drop the export relay payload.", error);
  }
}

export async function readExportPayload(key) {
  if (!key) {
    return null;
  }

  const cache = await caches.open(RELAY_CACHE);
  const response = await cache.match(key);
  if (!response) {
    return null;
  }

  await cache.delete(key);
  return response.json();
}
