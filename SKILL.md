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
  proxy.pac             图片 CDN 定向代理规则（只把 *.media-amazon.com 交给本地代理）
  run.sh                一条龙入口：Chrome→扩展→抓取→xlsx→交付
  setup.sh              环境自检/安装（幂等；--check 只诊断）
  feishu_send_file.py   飞书上传+发送（可选投递，ID 走环境变量）
tests/                  扩展单元测试（node --test tests/*.test.mjs，人工开发用，agent 无需跑）
specs/, docs/           扩展开发规格与运行文档
```

## 安装为 skill

```bash
git clone git@github.com:Ian-nextai/AMZ-Listing-Check.git ~/.hermes/skills/devops/amazon-listing-check
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
<skill目录>/scripts/run.sh "B09B8V1LZ3,B00FLYWNYQ" [--zip 10010] [--delay 1200] \
    [--with-reviews] [--retry 1] [--feishu] [--feishu-to <id>] [--id-type open_id] \
    [--fresh-profile] [--check-login]
```
- **差评默认关**；`--with-reviews` 才开且强制登录态检测
- `--retry N`（默认 1）：失败 ASIN（如偶发"标签页加载超时"）自动补跑
- 输出 `XLSX=$HOME/Downloads/amazon-listing-check-*.xlsx`；机器可读结果 `/tmp/amz-last-run.json`（字段：success/failed/failures/rows/mainXlsx/retryXlsx/retriedSuccess）
- 退出码：0 至少1个成功 / 1 链路错误 / 2 全部失败 / 3 差评模式未登录

**4. 验证产物**（严谨要求）：xlsx 用 openpyxl 打开核对行数=ASIN 数、表头列齐（差评关 16 列 / 开 17 列）：
```bash
python3 -c "import openpyxl; ws=openpyxl.load_workbook('$HOME/Downloads/<文件>').active; [print([str(c)[:40] if c else '' for c in r]) for r in ws.iter_rows(values_only=True)]"
```

**5. 交付（硬性规则）**：
- **用户没选 --feishu → agent 必须在回复中直接把 xlsx 作为文件交付**（Ekko 场景写 `MEDIA:$HOME/Downloads/<文件>`；其他平台用对应的文件引用格式），不许只报路径
- 用户选了 --feishu → run.sh 已自动发送并打印 message_id，回复里报数即可（成功N失败M+message_id），不必重复发文件

## 性能与策略（实测 2026-09-22/23）
- 单 ASIN 全检查（含差评）40–80s；差评关约 25–35s
- 持久 profile（$HOME/.hermes/amazon-profile）省邮编重设 ~40s/批 + cookie 温热降 robot 风险
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
16. **A图/详情图 缺图（不是解析器问题，是下载失败）**：`m.media-amazon.com` 被按 **SNI 阻断**——TLS 握手刚发 ClientHello 就收 RST（`curl` exit 35 / HTTP=000，扩展内 `fetch` 报 `Failed to fetch`），同 IP 换 SNI 到 `images-na.ssl-images-amazon.com` 立刻 TLSv1.3 成功。**同一图片路径在所有 Amazon 图片 CDN 主机上是同字节**（实测 33818 bytes 完全一致），所以 `image-fetch.js` 里加了 `imageUrlCandidates()` 回退链：原主机优先，失败依次 `images-na` → `images-fe` → `images.amazon.com`（路径/查询串原样保留；`{hosts:false}` 可关）。新用到的域名必须同时加进 manifest `host_permissions`，否则扩展自己会拦下请求。
    - **为什么"页面能看图、抓取却没图"**：页面里 `<img>` 用的域名由 Amazon 按你的网络下发（多半就是 images-na），而扩展是从 `colorImages` JSON 里取 `hiRes`，该字段恒为 `m.media-amazon.com`——正好踩中被掐的那条。
    - **为什么修复前"只有个别图缺"**：扩展 fetch 用 `cache:"force-cache"`，之前命中过 HTTP 缓存的图能拿到（实测 27ms、33818 bytes），**没缓存过的新图必然失败**。所以别被"大部分图都在"误导成偶发。
    - 失败是**静默**的：结果里只留 `imageAError:"A图下载失败。"`，行仍是 success。逐 ASIN 原始数据在 chrome.storage 的 `amzResult:<ASIN>` 键（**不是** `task.resultsByAsin`，导出后会被清空）。
    - 诊断顺序：① `curl` 直连该 CDN 拿 HTTP 码（000=网络不通）→ ② 同路径换域名再打一次（200 即回退方案成立）→ ③ 在扩展上下文用 `cache:"no-store"` 复测（绕开缓存才看得见真相）→ ④ 表头用 `check-xlsx-header.mjs` 核、图片落点看 `xl/drawings/drawing1.xml` 的 `<col>/<row>`（0 基，col 14=A图、15=详情图）。
    - 兜底：`run.sh --image-proxy <host:port>` 可把 `*.media-amazon.com` 交给本地代理（PAC 经 HTTP 提供，`--proxy-pac-url=file://` 实测被 Chrome 静默忽略）；仅在连备用 CDN 域名也取不到时才需要。
17. **图片负缓存毒化（详情图整批归零，比缺图更隐蔽）**：`fetchListingImage` 原来把 `fetchImageAsBase64` 的返回值**无条件**写缓存，失败返回的 `null` 也被缓存住且永不过期。Amazon 的 A+ 详情图常有一张**全店共用 banner**，于是某次瞬时抖动失败后，之后每个 ASIN 的同一 URL 都命中这个 null → 详情图成批归零，而行仍是 success。特征：**A图 全满、详情图从某一批起断崖式为零**，偶有批次部分恢复（缓存被 drain 后短暂自愈，随后再次毒化）。处置：缓存策略改到 `image-cache.js` 的 `loadImageIntoCache()`（**成功才写缓存**，失败返回 null 但不落盘，下次重试即自愈），并单测覆盖"一次抖动不毒化后续"。⚠️`image-cache.js` 原注释把负缓存写成"有意设计"，别再照着它改回去。
18. **run.sh 里文件名列表绝不能流经 `eval`**：批量跑有几十个 xlsx 时，`XLSX_LIST="..."` 这条超长赋值穿过 `python -c "..."` → `$(...)` → `eval` 三层后引号会被吃掉，shell 把第二个文件名当命令执行（`command not found`），随后 `set -u` 下报 `XLSX_LIST: unbound variable`，退出码 1 —— **抓取其实全成功**，极易误判为任务失败。单个文件时不复现，小批量测试永远暴露不了。正确做法：文件名逐行写临时文件，shell 侧 `while IFS= read -r` 读。回归验证：抽脚本片段 + 伪造 60 文件名的报告，旧版 EXIT=1 / 新版 EXIT=0。
19. **`run.sh` 报 `Inspected target navigated or closed`（本机实测根因）**：不是端口占用，是 `$HOME/.hermes/amazon-profile/` 下的 `SingletonLock` / `SingletonCookie` / `SingletonSocket` 残留（上次 Chrome 被强杀来不及删），下次启动 Chrome 以为已有实例在跑而异常退出，run.sh 的端口探测却误判成功。
    **排查顺序：先清 Singleton，再看端口**（只看端口会漏判——端口 free 不代表锁干净）：
    ```bash
    ps -eo pid,cmd | grep "chrome-linux64/chrome" | grep -v grep | awk '{print $1}' | xargs -r kill -9
    rm -f $HOME/.hermes/amazon-profile/Singleton{Lock,Cookie,Socket}
    ```
    实测：清锁前必挂，清锁后 405/405 通过。别用 `--fresh-profile`（会丢登录态和邮编）。
    **别把手动起的 Chrome 留在后台** —— 它正是下一次失败的来源。
20. **增量交付时记得补时间列**：用户要的"抓取时间"是批导出时刻（扩展只在每批导出打时间戳，无行级时间）。用文件名里的 UTC 时间戳转 UTC+8，并加"批次"列。合并多批 xlsx 时注意**重试批会产出重复 ASIN**，需跨批去重（不是批内）。

21. **Fitment Bar（页面左上角 Amazon Confirmed Fit 区块）有无检测**（2026-10-01）：只要二值判断，输出 **「有」/「无」**，不采车型、不判相符 —— 适配状态是相对页面当前选中的那辆车，换车就变，不是 listing 的固有属性。
    **判定绝不能搜 `partfinder` 关键字**：那段 CSS 类名在没有该区块的页面里一样存在（实测 43 处），会把所有 ASIN 都误判成「有」。必须用已渲染 widget 上的 `data-component-id="automotive-pf-primary-view"` —— 实测该标记在有区块的页面出现 1 次、无区块的页面 0 次，判别干净。
    **这一列有意对缺失也输出「无」而不是留空**：留空会和"没跑这项检查"混淆。
    **新增一个检查项要改四处，漏一处就静默不生效**（踩过：只改了 parser + export-plan，列根本没出来）：
    `amazon-parser.js` 的 `extractAmazonListingChecks` → `export-plan.js` 的 `EXPORT_COLUMNS`（`check` 字段即开关名）→ `task-state.js` 的 `CHECK_KEYS` 白名单与 `recordTaskSuccess` 字段 → `drive.mjs` 的 `CHECKS` 与 `popup.html/js`。
    另：改完扩展必须 bump manifest version 并清 `$PROFILE/Default/Service Worker`（见第 13 条），否则跑的还是旧模块、新列不出现。还有 `deepStrictEqual` 断言会因新增字段打挂，用"未启用时该字段完全不出现"（条件展开）规避，别塞 null/undefined。

22. **脚本里不要硬编码 `/root`**（2026-10-03，外部用户反馈）：非 root 用户下 `PROFILE=/root/.hermes/amazon-profile` 会 `mkdir: Permission denied`、`DOWNLOADS=/root/Downloads` 会让产物路径显示错误（Chrome 实际把文件存到用户自己的 `~/Downloads`，脚本却打印 `/root/Downloads`，用户根本找不到文件）。还会导致 profile 无法持久化（Chrome 退化到临时 profile，登录态/邮编每次都丢）。
    **规则**：所有可写路径一律基于 `$HOME`，需要固定位置时用环境变量覆盖。`run.sh` 现有 `AMZ_PROFILE` / `AMZ_DOWNLOADS` / `AMZ_PORT` 三个覆盖点；`setup.sh --check` 第 7 节会校验这两个目录可写。
    注意 `set -u` 没有 `set -e`，`mkdir -p` 失败**不会中断脚本**，所以症状可能是"能跑但路径全错"，而不是直接报错——更隐蔽。
    验证方式：`useradd -m tester`，把仓库与 Chromium 放到其可读路径，`su - tester` 实跑一次。

## 扩展单独人工使用（不跑无头链路时）

`assets/extension/` 本身就是标准 Chrome 扩展：Chrome → `chrome://extensions` → 开发者模式 → **Load unpacked** → 选该目录。Popup 里贴 ASIN 列表、勾检查项（含差评）、填邮编，点开始即可，导出的 xlsx 走浏览器下载。manifest 里的固定 key 不影响人工使用。

## 扩展升级流程

仓库 `git pull` 后：确认 `assets/extension/background.js` 的 `TAB_LOAD_TIMEOUT_MS=150000` 仍在（被还原就重改）、manifest `key` 仍在，然后 `scripts/setup.sh --check` 验证。
