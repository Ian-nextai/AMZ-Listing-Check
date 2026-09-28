// Amazon 图片 CDN 定向代理（PAC）。
//
// 背景：m.media-amazon.com 在部分网络（如中国大陆直连）会被 TLS 层重置
// （curl 表现为 exit 35 / HTTP=000，浏览器表现为 fetch 报 "Failed to fetch"），
// 而 www.amazon.com 直连正常。表现是：商品页能抓、A图/详情图 却随机缺图，
// 扩展日志里对应 imageAError = "A图下载失败。"（下载失败被静默吞掉，只留这一句）。
//
// 只把图片 CDN 交给本地代理，其余（尤其 www.amazon.com）保持 DIRECT——
// 已登录会话的出口 IP 不变，不会因为整体换 IP 触发风控。
//
// __IMAGE_PROXY__ 由 run.sh 替换为实际代理地址（默认 127.0.0.1:7890）。
function FindProxyForURL(url, host) {
  if (host === "media-amazon.com" || shExpMatch(host, "*.media-amazon.com")) {
    return "PROXY __IMAGE_PROXY__";
  }
  return "DIRECT";
}
