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
| `run.sh` | Linux 一条龙入口（含登录门禁、失败自动重试、飞书投递） |
| `run.ps1` | Windows 一条龙入口，同上；浏览器发现/profile/进程管理按 Windows 重写 |
| `drive.mjs` | 扩展驱动器：CDP 附加 runner.html 页面，经 `chrome.runtime.sendMessage` 控制 SW |
| `cdp.mjs` | 零依赖 CDP-over-WebSocket 客户端（等 101 握手、ping/pong、每请求超时） |
| `check-login.mjs` | Amazon 登录态检测（读 amazon.com 账户问候语） |
| `feishu_send_file.py` | 飞书上传+发送（可选投递通道，ID 走环境变量） |

## 快速开始

### 1. 环境要求

Linux（ARM64/x86_64）或 Windows（见下方「Windows（原生）」）、Node ≥ 18（runner 零 npm 依赖）、
Python 3 + openpyxl（仅飞书投递需要）、能直连 `www.amazon.com`。

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
./scripts/setup.sh          # 检查并自动补装缺件
./scripts/setup.sh --check  # 只诊断
```

### 4. 跑任务

```bash
./scripts/run.sh "B0GY48WL28,B0GY49QL6C" [选项]
```

| 选项 | 说明 |
|---|---|
| `--zip 10010` | 配送邮编（默认 10010） |
| `--delay 1200` | ASIN 间隔 ms（默认 1200） |
| `--max-image-edge 512` | 图片长边上限 px（128/256/512/1024，`0`=不压缩；省略则用扩展里上次保存的设置） |
| `--with-reviews` | 差评收集开（**默认关**；需先登录，见下） |
| `--retry 1` | 失败 ASIN 自动补跑次数（默认 1） |
| `--chunk 8` | 每批 ASIN 数（默认 0=不分批）；批间清空扩展图片缓存，见下 |
| `--feishu` | 跑完自动发飞书（文件+摘要） |
| `--feishu-to <id>` `--id-type open_id\|chat_id` | 飞书接收者 |
| `--check-login` | 只检测 Amazon 登录态 |
| `--fresh-profile` | 删除持久 profile 冷启动（慎用，会丢邮编/登录态） |

产物：
- `/root/Downloads/amazon-listing-check-<时间>.xlsx`
- `/tmp/amz-last-run.json`（机器可读结果）

退出码：`0` 至少 1 个成功 / `1` 链路错误 / `2` 全部失败 / `3` 差评模式未登录。

## Windows（原生）

`run.ps1` 是 `run.sh` 的 Windows 对应物，功能一致。`drive.mjs` / `cdp.mjs` /
`check-login.mjs` 本来就跨平台，直接复用；只有浏览器发现、profile 路径和进程
管理是 Windows 专属的。

```powershell
.\scripts\run.ps1 "B0GY48WL28,B0GY49QL6C"
.\scripts\run.ps1 "B0GY48WL28" -WithReviews -Chunk 8 -MaxImageEdge 512
.\scripts\run.ps1 "B0GY48WL28" -CheckLogin
.\scripts\run.ps1 "B0GY48WL28" -Login        # 打印人工登录指引
```

参数与 `run.sh` 的选项一一对应（`-Zip` `-Delay` `-MaxImageEdge` `-WithReviews`
`-Retry` `-Chunk` `-Port` `-FreshProfile` `-CheckLogin` `-Login`），另有
`-Browser <路径>` / `-TimeoutMin`。

与 Linux 版的差异：

- **不需要装 Playwright**。浏览器发现按 **Edge → Chrome for Testing** 的顺序
  找（原因见下），也可以直接用 `-Browser <路径>` 或 `$env:AMZ_BROWSER` 指定。
- Profile 在 `%LOCALAPPDATA%\amz-check-profile`；xlsx 落在
  `%USERPROFILE%\Downloads`。
- 启动前按 **profile 路径**匹配结束残留的 chrome/msedge（`Get-CimInstance
  Win32_Process`），不会动你正在用的浏览器。
- 登录不需要 xvfb/VNC/隧道：`run.ps1 <ASINs> -Login` 会打印一条可见窗口的启动
  命令，人工登录后关掉，cookie 就落在同一个 profile 里。
- 报告在 `%TEMP%\amz-last-run.json`（`drive.mjs` 用 `os.tmpdir()`，Linux 上仍是
  `/tmp`）。

前置条件：Node ≥ 18（`node --version`）、能直连 amazon.com。飞书投递仍需
Python + openpyxl，且只有 `run.sh` 走飞书。

### 为什么不用 Google Chrome

**品牌版 Google Chrome 从 137 起禁止命令行加载扩展**。传 `--load-extension` 不会
报错退出，只在浏览器日志里留一行：

```
WARNING:chrome\browser\extensions\extension_service.cc:423]
--load-extension is not allowed in Google Chrome, ignoring.
```

扩展静默不加载，于是 CDP 的 target 列表里根本没有扩展页，`drive.mjs` 最后只报
「runner 页不可用」——现象和「扩展写错了」一模一样，非常容易误诊（本仓库在
Chrome 154 上实测踩过）。`--disable-features=DisableLoadExtensionCommandLineSwitch`
也解不开。

所以 `run.ps1` 的发现顺序是：

1. **Microsoft Edge** —— Windows 自带，**本仓库实测能加载**（默认选择）
2. **Chrome for Testing** —— Google 官方为自动化发布的构建；放在
   `%LOCALAPPDATA%\amz-check-chrome\chrome.exe` 即可被自动发现。
   它同样出自品牌构建链，本仓库**未在 Windows 上实测**这条路，若也不生效请退回 Edge
3. 只找到品牌版 Chrome 时**直接报错并给出两条出路**，而不是让扩展静默不加载

要装 Chrome for Testing：到 <https://googlechromelabs.github.io/chrome-for-testing/>
下载 `chrome-win64.zip`，解压后让 `chrome.exe` 落在
`%LOCALAPPDATA%\amz-check-chrome\`（或任意位置 + `-Browser`）。

> Linux 侧不受影响：`run.sh` 用的是 Playwright 下载的 Chromium，不是品牌版 Chrome。

## 分批与内存（`--chunk`）

一次跑几十个 ASIN 时，扩展侧有三处内存随批量线性增长，在低内存设备（手机、
小内存 VPS）上足以把浏览器进程压死：

1. **图片缓存** —— 抓下来的 base64 图按 URL 缓存在 service worker 里（供重复
   导出复用），有 64MB 上限、按插入顺序淘汰；默认 256px 时很小，但选 `1024`
   或 `--max-image-edge 0`（原始尺寸）时每张几百 KB，几十个 ASIN 就能堆到几十 MB。
2. **导出峰值** —— 导出是**一次性**把全部结果拼成 workbook，再整包解压注入图片
   重压，峰值随总 ASIN 数线性涨。
3. **结果与日志** —— `chrome.storage.local` 每次 ASIN 全量写一遍（含最多 250 条
   日志），而 MV3 的 `storage.local` 默认上限 10MB。

`--chunk N` 把 ASIN 切成每批 N 个：每批独立跑、独立导出成自己的 xlsx，**批间清空
图片缓存**（`clear-image-cache` 消息），失败重试也只在批内补跑。峰值从「随总数
线性增长」变成「一批的固定量」，代价是产物是多个 xlsx 而不是一个。
`amz-last-run.json` 的 `xlsxFiles` 列出全部文件，`peakImageCacheBytes` 记录本
轮图片缓存峰值，可用来判断该把 N 调多小。

> 单批仍受最低内存约束：完整 Chromium + 一个 Amazon 商品页渲染器本身就要
> 600MB–1GB。分片解决的是**随批量增长**的那部分，不是基线。真要在小内存设备上
> 跑，除了调小 `--chunk`，还要关掉不勾选的抓取项（尤其差评和原始尺寸图片）。

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
/root/.cache/ms-playwright/chromium-*/chrome-linux*/chrome \   # 版本号按实际安装的为准
  --no-sandbox --user-data-dir=/root/.hermes/amazon-profile \
  --display=:99 "https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2F"

# 用户在手机浏览器打开 https://<随机>.trycloudflare.com/vnc.html 亲手登录
# 登录后：正常退出 Chrome（cookie 落盘）→ 拆除全部组件 → 删密码文件
./scripts/run.sh <ASINs> --check-login   # 验证：loggedIn:true, "Hello, <用户名>"
```

> 注意：直接导航 `amazon.com/ap/signin` 可能落到错误页；带 `openid.return_to` 参数从主页流程进入才稳。

## 对扩展的两处运行修复

相对仓库原始扩展，runner 依赖以下改动（已直接应用在本仓库）：

1. **`background.js`：`TAB_LOAD_TIMEOUT_MS` 45000 → 150000**
   大商品页（HTML > 2MB + 全尺寸图）在 ARM 设备上 `load complete` 可超过 45s，原值会整批 ASIN 报「标签页加载超时」。150s 实测覆盖。
2. **`manifest.json` 注入固定 `key`**
   `--load-extension` 以解压目录方式加载时，无 key 的扩展每次启动 ID 会变，CDP 定位/驱动不稳定。固定 key 后扩展 ID 恒为 `ahdchbhmgiaciipjijlckjpheflbfiin`。

> `--load-extension` 只接受**解压后的目录**，传 .zip 会被 Chrome 静默忽略。
> Windows 上还要注意它只在 Edge / Chrome for Testing 里生效，见上文
> 「为什么不用 Google Chrome」。

## 实测性能（ARM64 手机, Android LMK 环境）

- 单 ASIN：差评关 ~25–35s；差评开 ~40–80s（大页面另加）
- 持久 profile：邮编只设一次（省 ~40s/批），cookie 温热降低 robot check 概率
- 偶发瞬时失败（超时）由 `--retry 1` 兜底
- 不建议并行多实例：单 IP 并发抓 Amazon 风控风险高，且完整 Chromium 各吃 ~250MB 内存

## 已知坑（runner 全部处理掉了）

1. `--load-extension` 不吃 .zip（静默忽略）→ 解压目录 + 固定 key
2. 品牌版 Chrome ≥ 137 禁用 `--load-extension`，且**不报错**只是静默忽略 →
   Windows 上改用 Edge / Chrome for Testing（见「为什么不用 Google Chrome」）
3. 必须完整版 Chromium + `--headless=new`
4. Chrome 内置 Gemini 组件扩展（ID `admccjkmock...`）会出现在 target 列表里冒充目标 → 启动加 `--disable-features=glic`
5. MV3 SW 冷启动不在 target 列表 → 打开 `runner.html` 唤醒；驱动必须从 runner 页面上下文 `chrome.runtime.sendMessage`（在 SW 里直调 `onMessage.listeners` 拿不到监听器）
6. CDP flatten 模式：`sessionId` 必须放消息**根级**，放 `params` 里报 `-32601 wasn't found`
7. 自写 WS 客户端：等 HTTP 101 握手完成才算连接就绪（TCP connect ≠ 可用）+ 每请求超时 + 回 ping（opcode 0x9→0xA）
8. VNC 密码文件必须 `x11vnc -storepasswd` 生成（DesCrypt 加密格式），明文文件 → "password check failed"
9. "Currently unavailable" 对中国 IP 常见——抓取本身成功，只是该买家地址不可售
10. **图片 CDN 被按 SNI 阻断 → A图/详情图 缺图**：`m.media-amazon.com` 在 TLS 握手阶段
   就被 RST（`curl` exit 35 / HTTP=000，扩展内 `fetch` 报 `Failed to fetch`），而同 IP
   换 SNI 到 `images-na.ssl-images-amazon.com` 立即成功，且**同一图片路径在各 Amazon 图片
   CDN 主机上返回同字节**。扩展因此内置域名回退链（`imageUrlCandidates()`：原主机优先，
   再依次 images-na → images-fe → images.amazon.com），无需任何代理即可取图。
   失败是静默的，只在结果里留 `imageAError: "A图下载失败。"`；扩展 fetch 用 `force-cache`，
   所以被缓存过的图能拿到、新图必然失败——别误判成偶发。
   若本机连备用 CDN 域名也不通，用 `--image-proxy <host:port>` 把 `*.media-amazon.com`
   交给本地代理（PAC 必须经 HTTP 提供：`--proxy-pac-url=file://` 会被 Chrome 静默忽略）。
11. **多文件时文件名列表不能经 `eval`**：批量跑有几十个 xlsx 时，把文件名拼成一条长的
   `XLSX_LIST="..."` 赋值再 `eval`，引号会在 `python -c "..." → $(...) → eval` 三层传递中
   丢失，shell 把第二个文件名当命令执行（`command not found`），随后 `XLSX_LIST: unbound
   variable`（`set -u`），退出码 1——但抓取本身全部成功。现改为逐行写临时文件 +
   `while IFS= read -r` 读取，临时文件在 EXIT trap 里无条件清理。单文件时不复现。
