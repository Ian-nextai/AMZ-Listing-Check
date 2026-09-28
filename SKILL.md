---
name: amazon-listing-check
description: Amazon Listing 批量检查全链路（自包含 skill）：无头 Chromium 加载 CRX 扩展抓 ASIN 数据（标题/评分/库存/配送/Buybox/差评）→ 导出 xlsx → 交付用户（回复内文件或可选飞书自动发）。装 skill 即用，含扩展、CDP 驱动脚本、一键 run.sh、登录态检测、环境自检 setup.sh。触发词：亚马逊 listing 检查、ASIN 批量抓取、amazon listing check、无头浏览器跑扩展、CRX headless。
triggers:
  - Amazon listing check / ASIN 批量抓取 / 亚马逊检查
  - 无头浏览器加载扩展 / load-extension / CRX headless
---

# Amazon Listing Check Helper — 自包含无头链路

本 skill 自带全部依赖，agent 按【标准流程】走即可。**第 0、5 步是与用户的硬约定，不可跳过。**

## 目录结构（skill 布局）
```
assets/extension/        解压后的 CRX（manifest 已注入固定 key → 扩展 ID 恒定 ahdchbhmgiaciipjijlckjpheflbfiin）
                        也可单独人工使用：Chrome → chrome://extensions → 开发者模式 → Load unpacked 选这个目录
scripts/                一键运行栈（零 npm 依赖）
  cdp.mjs               CDP-over-WebSocket 客户端
  drive.mjs             扩展驱动器（经 runner.html 消息路由控制 SW，含自动重试）
  check-login.mjs       Amazon 登录态检测
  check-xlsx-header.mjs 产物守卫：校验导出表头是否含本次启用的列
  run.sh                一条龙入口：Chrome→扩展→抓取→xlsx→交付
  setup.sh              环境自检/安装（幂等；--check 只诊断）
  feishu_send_file.py   飞书上传+发送（可选投递，ID 走环境变量）
tests/                  扩展单元测试（node --test tests/*.test.mjs，人工开发用，agent 无需跑）
specs/, docs/           扩展开发规格与运行文档
```

## 安装为 skill

```bash
git clone git@github.com:keithqwq/AMZ-Check-CRX.git ~/.hermes/skills/devops/amazon-listing-check
```

clone 后目录直接就是 skill 根（SKILL.md 在顶层），无需再嵌套。

## 标准流程（agent 严格按此走）

**第 0 步（硬性）：跑之前必须与用户确认检查项。** 不得默认开跑。向用户确认：
- ASIN 列表（用户给定）
- 差评收集开不开？**默认关**（省约 40% 耗时；开则须先登录，见第 3.5 步）
- 配送邮编（默认 10010）、间隔（默认 1200ms）
- 交付方式：飞书自动发（--feishu）还是 agent 回复内交付文件（默认）

**1. 首次使用自检**（幂等）：
```bash
<skill目录>/scripts/setup.sh          # 检查并自动补装缺件
<skill目录>/scripts/setup.sh --check  # 只诊断
```

**2. （仅当用户要差评）登录态确认**：
```bash
<skill目录>/scripts/run.sh <ASINs> --check-login   # 输出 LOGIN={"loggedIn":..}
```
- `loggedIn: false` → 让用户先登录（见 docs/runner.md「登录」一节），**登录并 profile 持久化之后才允许跑差评**。差评模式未登录 run.sh 会硬性退出（exit 3），不要绕过。
- 提醒用户：之后每次抓取都以该账号身份访问 Amazon，有账号风控的理论风险，确认后再做

**3. 跑任务**（一条命令）：
```bash
<skill目录>/scripts/run.sh "B0GY48WL28,B0GY49QL6C" [--zip 10010] [--delay 1200] \
    [--with-reviews] [--retry 1] [--feishu] [--feishu-to <id>] [--id-type open_id] \
    [--fresh-profile] [--check-login]
```
- **差评默认关**；`--with-reviews` 才开且强制登录态检测
- `--retry N`（默认 1）：失败 ASIN（如偶发"标签页加载超时"）自动补跑
- 输出 `XLSX=/root/Downloads/amazon-listing-check-*.xlsx`；机器可读结果 `/tmp/amz-last-run.json`（字段：success/failed/failures/rows/mainXlsx/retryXlsx/retriedSuccess）
- 退出码：0 至少1个成功 / 1 链路错误 / 2 全部失败 / 3 差评模式未登录

**4. 验证产物**（严谨要求）：xlsx 用 openpyxl 打开核对行数=ASIN 数、表头列齐（差评关 16 列 / 开 17 列）：
```bash
python3 -c "import openpyxl; ws=openpyxl.load_workbook('/root/Downloads/<文件>').active; [print([str(c)[:40] if c else '' for c in r]) for r in ws.iter_rows(values_only=True)]"
```

**5. 交付（硬性规则）**：
- **用户没选 --feishu → agent 必须在回复中直接把 xlsx 作为文件交付**（Ekko 场景写 `MEDIA:/root/Downloads/<文件>`；其他平台用对应的文件引用格式），不许只报路径
- 用户选了 --feishu → run.sh 已自动发送并打印 message_id，回复里报数即可（成功N失败M+message_id），不必重复发文件

## 性能与策略（实测 2026-09-22/23）
- 单 ASIN 全检查（含差评）40–80s；差评关约 25–35s
- 持久 profile（/root/.hermes/amazon-profile）省邮编重设 ~40s/批 + cookie 温热降 robot 风险
- 偶发"标签页加载超时"瞬时失败 → --retry 1 自动补跑解决
- 批量建议 delay ≥ 1000ms；不并行多实例（robot 风险 + 内存）
- 纯 HTTP 抓取会被 edgex/guard 反爬拦截（实测），必须走完整 Chromium

## 关键坑（全踩过，勿重蹈）
1. `--load-extension` **只吃解压目录不吃 .zip**，Chrome 静默忽略 zip。manifest 注入固定 `key` → 扩展 ID 恒定
2. 必须**完整版 Chromium + `--headless=new`**；`chromium_headless_shell`（旧 headless）不支持扩展
3. `/json/list` 里 `admccjkmock...` 是 Chrome 内置 Gemini 扩展，别认成目标扩展。启动加 `--disable-features=glic`
4. MV3 SW 冷启动后不在 target 列表 → 开 `chrome-extension://<ID>/runner.html` 唤醒；**驱动必须从 runner.html 页面上下文 `chrome.runtime.sendMessage`**（SW 内直调 onMessage.listeners 拿不到监听器）
5. CDP flatten 模式：`sessionId` 放消息**根级**（`{id,method,params,sessionId}`），放 params 里报 `-32601`
6. 自写 WS 客户端必须等 HTTP 101 握手再 resolve + 每请求超时 + 回 ping（0x9→0xA）
7. 缺 `libatk-bridge2.0-0` 时 Chrome 起不来 → `apt-get install -y libatk-bridge2.0-0`
8. "Currently unavailable" 对中国 IP 常见，抓取本身成功；真在售商品返回 Buybox/seller/配送
9. run.sh 结束若 Chrome 残留：`pkill -f remote-debugging-port=19222`
10. **差评未登录拿不全**（Amazon 登录墙），检测到 loggedIn:false 别硬跑差评模式
11. **大商品页（HTML>2MB+大图）在 ARM 上 load complete 可超 45s** → 扩展 `TAB_LOAD_TIMEOUT_MS` 已提到 150000。若用 git pull 拉新版扩展后此值被还原，**必须重新改这行**
12. **登录会话实操**：xvfb+x11vnc+novnc（密码文件必须 `x11vnc -storepasswd` 生成加密格式）+ `cloudflared tunnel --url` 临时隧道，用户手机进 noVNC 亲手登录 → 正常退出 Chrome 落盘 cookie → 拆组件删密码。验证：check-login.mjs 输出 "Hello, <名>" 或查 profile Cookies 库的 x-main/at-main/session-token。详见 docs/runner.md
13. **改了扩展代码却导出旧列（最隐蔽的坑，曾静默丢三列）**：任务实际跑在 MV3 Service Worker 里，而 SW 的**模块图**被 profile 缓存；只重启浏览器、甚至 bump manifest version 都不够（扩展页面 runner.html 读到的是新文件，SW 跑的是旧模块）。症状是任务全部 success、xlsx 却少列。处置：`run.sh` 启动前 `rm -rf "$PROFILE/Default/Service Worker"`（只删该目录，cookie 在 Default/Cookies 不受影响）。**别用「读已加载扩展的 manifest version」做校验**——manifest 每次启动都新读，测不出旧模块，会误报。
14. **产物守卫**：`run.sh` 跑完用 `check-xlsx-header.mjs` 断言表头含本次启用的列（失败即 exit 1），直接校验产物而非相信运行过程。注意 vendor/xlsx.mjs 是 SheetJS **浏览器构建**，`readFile()` 是抛 "Cannot access file" 的桩函数，必须用 `node:fs` 读字节再 `XLSX.read(buf,{type:'array'})`。
15. `find /` 全盘搜索在这台机器上会跑到超时（Android/Termux 宿主），排查文件用定向 `ls`/`grep`；`ls | head` 会截断下载目录列表，误判"文件没生成"。

## 扩展单独人工使用（不跑无头链路时）

`assets/extension/` 本身就是标准 Chrome 扩展：Chrome → `chrome://extensions` → 开发者模式 → **Load unpacked** → 选该目录。Popup 里贴 ASIN 列表、勾检查项（含差评）、填邮编，点开始即可，导出的 xlsx 走浏览器下载。manifest 里的固定 key 不影响人工使用。

## 扩展升级流程

仓库 `git pull` 后：确认 `assets/extension/background.js` 的 `TAB_LOAD_TIMEOUT_MS=150000` 仍在（被还原就重改）、manifest `key` 仍在，然后 `scripts/setup.sh --check` 验证。
