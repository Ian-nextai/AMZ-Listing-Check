# Runner：无头全链路运行器

把 CRX 扩展跑在**无头 Chromium**里的完整运行栈——不需要人工点浏览器，一条命令完成「启动浏览器 → 加载扩展 → 驱动抓取 → 导出 xlsx →（可选）发飞书」。

```
┌─────────┐   ┌──────────────────────┐   ┌─────────────────────┐
│ run.sh  │──▶│ Chromium (headless)  │──▶│ 本仓库 CRX 扩展     │
│ 一条龙  │   │ + 持久 profile       │   │ (amazon-listing-    │
└────┬────┘   └──────────┬───────────┘   │  check-extension/)  │
     │ CDP over WS       │               └─────────┬───────────┘
     ▼                   │ tabs/scripting/downloads ▼
 drive.mjs ◀── runner.html 消息路由      Amazon.com → /root/Downloads/*.xlsx
```

## 为什么需要 runner

- 纯 HTTP 请求 Amazon 被 `edgex/guard` 反爬拦截（实测）；完整 Chromium 的 TLS 指纹 + JS 环境过得了 bot 检测
- MV3 扩展在 `--headless=new` 下可正常工作，但 service worker 冷启动 / 消息路由 / 下载落盘都有坑（见下文），runner 把这些全部封装掉

## 文件

| 文件 | 职责 |
|---|---|
| `setup.sh` | 环境自检/自动补装（Chromium、libatk-bridge、扩展完整性、飞书凭据、网络） |
| `run.sh` | 一条龙入口（含登录门禁、失败自动重试、飞书投递） |
| `drive.mjs` | 扩展驱动器：CDP 附加 runner.html 页面，经 `chrome.runtime.sendMessage` 控制 SW |
| `cdp.mjs` | 零依赖 CDP-over-WebSocket 客户端（等 101 握手、ping/pong、每请求超时） |
| `check-login.mjs` | Amazon 登录态检测（读 amazon.com 账户问候语） |
| `feishu_send_file.py` | 飞书上传+发送（可选投递通道，ID 走环境变量） |

## 快速开始

### 1. 环境要求

Linux（ARM64/x86_64）、Node ≥ 18（runner 零 npm 依赖）、Python 3 + openpyxl、能直连 `www.amazon.com`。

### 2. 安装 Chromium 完整版

```bash
mkdir -p /tmp/pw && cd /tmp/pw
npm init -y && npm i playwright-core@1.62.1
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.playwright.dev npx playwright-core install chromium --no-shell
apt-get install -y libatk-bridge2.0-0
```

> 必须是**完整版 Chromium**。旧版 `chromium_headless_shell` 不支持扩展。

### 3. 自检

```bash
./runner/setup.sh          # 检查并自动补装缺件
./runner/setup.sh --check  # 只诊断
```

### 4. 跑任务

```bash
./runner/run.sh "B0GY48WL28,B0GY49QL6C" [选项]
```

| 选项 | 说明 |
|---|---|
| `--zip 10010` | 配送邮编（默认 10010） |
| `--delay 1200` | ASIN 间隔 ms（默认 1200，防 robot check） |
| `--with-reviews` | 差评收集开（**默认关**；需先登录，见下） |
| `--retry 1` | 失败 ASIN 自动补跑次数（默认 1） |
| `--feishu` | 跑完自动发飞书（文件+摘要） |
| `--feishu-to <id>` `--id-type open_id\|chat_id` | 飞书接收者 |
| `--check-login` | 只检测 Amazon 登录态 |
| `--fresh-profile` | 删除持久 profile 冷启动（慎用，会丢邮编/登录态） |

产物：
- `/root/Downloads/amazon-listing-check-<时间>.xlsx`
- `/tmp/amz-last-run.json`（机器可读结果）

退出码：`0` 至少 1 个成功 / `1` 链路错误 / `2` 全部失败 / `3` 差评模式未登录。

## 登录（解锁完整差评）

未登录 Amazon 只能看到部分评论。差评模式会在开跑前自动检测登录态（`check-login.mjs`），未登录硬性拦截（exit 3）。

无 GUI 服务器的登录方法（xvfb + VNC + 临时隧道，实测可用）：

```bash
apt-get install -y xvfb x11vnc novnc
x11vnc -storepasswd '一次性密码' /root/.vnc-auth.enc   # 必须是加密格式，明文会 password check failed
Xvfb :99 -screen 0 1280x900x24 &
x11vnc -display :99 -rfbauth /root/.vnc-auth.enc -noxdamage -repeat -forever -shared &
websockify --web /usr/share/novnc 8788 localhost:5900 &
cloudflared tunnel --url http://127.0.0.1:8788 &       # 输出临时公网 URL

# 完整版 Chrome（非 headless）+ 持久 profile：
/root/.cache/ms-playwright/chromium-1234/chrome-linux/chrome \
  --no-sandbox --user-data-dir=/root/.hermes/amazon-profile \
  --display=:99 "https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2F"

# 用户在手机浏览器打开 https://<随机>.trycloudflare.com/vnc.html 亲手登录
# 登录后：正常退出 Chrome（cookie 落盘）→ 拆除全部组件 → 删密码文件
./runner/run.sh <ASINs> --check-login   # 验证：loggedIn:true, "Hello, <用户名>"
```

> 注意：直接导航 `amazon.com/ap/signin` 可能落到错误页；带 `openid.return_to` 参数从主页流程进入才稳。

## 对扩展的两处运行修复

相对仓库原始扩展，runner 依赖以下改动（已直接应用在本仓库）：

1. **`background.js`：`TAB_LOAD_TIMEOUT_MS` 45000 → 150000**
   大商品页（HTML > 2MB + 全尺寸图）在 ARM 设备上 `load complete` 可超过 45s，原值会整批 ASIN 报「标签页加载超时」。150s 实测覆盖。
2. **`manifest.json` 注入固定 `key`**
   `--load-extension` 以解压目录方式加载时，无 key 的扩展每次启动 ID 会变，CDP 定位/驱动不稳定。固定 key 后扩展 ID 恒为 `ahdchbhmgiaciipjijlckjpheflbfiin`。

> `--load-extension` 只接受**解压后的目录**，传 .zip 会被 Chrome 静默忽略。

## 实测性能（ARM64 手机, Android LMK 环境）

- 单 ASIN：差评关 ~25–35s；差评开 ~40–80s（大页面另加）
- 持久 profile：邮编只设一次（省 ~40s/批），cookie 温热降低 robot check 概率
- 偶发瞬时失败（超时）由 `--retry 1` 兜底
- 不建议并行多实例：单 IP 并发抓 Amazon 风控风险高，且完整 Chromium 各吃 ~250MB 内存

## 已知坑（runner 全部处理掉了）

1. `--load-extension` 不吃 .zip（静默忽略）→ 解压目录 + 固定 key
2. 必须完整版 Chromium + `--headless=new`
3. Chrome 内置 Gemini 组件扩展（ID `admccjkmock...`）会出现在 target 列表里冒充目标 → 启动加 `--disable-features=glic`
4. MV3 SW 冷启动不在 target 列表 → 打开 `runner.html` 唤醒；驱动必须从 runner 页面上下文 `chrome.runtime.sendMessage`（在 SW 里直调 `onMessage.listeners` 拿不到监听器）
5. CDP flatten 模式：`sessionId` 必须放消息**根级**，放 `params` 里报 `-32601 wasn't found`
6. 自写 WS 客户端：等 HTTP 101 握手完成才算连接就绪（TCP connect ≠ 可用）+ 每请求超时 + 回 ping（opcode 0x9→0xA）
7. VNC 密码文件必须 `x11vnc -storepasswd` 生成（DesCrypt 加密格式），明文文件 → "password check failed"
8. "Currently unavailable" 对中国 IP 常见——抓取本身成功，只是该买家地址不可售
