// 检查持久 profile 的 Amazon 登录态：开 amazon.com 读账户问候语。
// 用法: node check-login.mjs [--port 19222]
// 输出: JSON 一行 {loggedIn, greeting, user} — run.sh/agent 消费
import { getBrowserWs, ws } from "./cdp.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const PORT = Number(opt("port", "19222"));

const browserWs = await getBrowserWs(PORT);
const c = await ws(browserWs);

// 开一个 amazon.com 页
const { targetId } = await c.send("Target.createTarget", { url: "https://www.amazon.com/" });
await new Promise(r => setTimeout(r, 8000)); // 等加载（含可能的 edgex 二次跳转）
const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });

const r = await c.sendSession(sessionId, "Runtime.evaluate", {
  expression: `JSON.stringify({
    url: location.href.slice(0, 80),
    g1: (document.querySelector('#nav-link-accountList .nav-line-1') || {}).textContent?.trim() || '',
    g2: (document.querySelector('#nav-link-accountList .nav-line-2') || {}).textContent?.trim() || '',
    accountNav: (document.querySelector('#nav-accountList-text') || {}).textContent?.trim() || ''
  })`,
  returnByValue: true
}).catch(() => null);

const info = r?.result?.value ? JSON.parse(r.result.value) : { g1: "", g2: "" };
// 未登录: "Hello, sign in" / 已登录: "Hello, <名>" 或 "您好, <名>"
const greeting = [info.g1, info.g2].filter(Boolean).join(", ");
const loggedIn = Boolean(info.g1) && !/sign in|登录|log in/i.test(info.g1);

console.log(JSON.stringify({
  loggedIn,
  greeting: greeting || "(未取到问候语，可能被 robot check)",
  url: info.url || ""
}));
await c.send("Target.closeTarget", { targetId }).catch(() => {});
c.close();
