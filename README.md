# 🛠 AMZ-Listing-Check

#### 亚马逊 Listing 批量检查：按 ASIN 抓全字段，导出带图 Excel

Chrome 扩展 · 无头链路 · XLSX 导出
License: MIT

给一串 ASIN，批量打开 Amazon 商品页，把标题、价格、优惠券、折扣、评分、库存、配送、A图/详情图、差评、Fitment Bar 一次抓全，导出成一张带内嵌图片的 Excel。

既能在服务器上无头跑（`scripts/run.sh` 一条命令），也能当普通 Chrome 扩展手动点着用。

---

## ✨ 能抓什么

每一个字段都能单独开关（popup 里勾选）：

| 列 | 来源 |
| --- | --- |
| 标题 | `#productTitle` |
| Highlight | 标题下的副标题，很多 ASIN 没有 |
| 评分 / 评分人数 | `#acrPopover`、`#acrCustomerReviewText` |
| 产品价格 | buy-box 实付价（不取划线参考价） |
| 优惠券 | 优惠券角标、claim tile、品牌促销码 |
| 折扣 | 省钱角标 + 参考价，如 `-9%（Typical price: $54.99）` |
| BP | `#feature-bullets` 合到一个单元格 |
| 差评 | 评论页筛 1–3 星，最多 30 条，编号后合到一个单元格（**需登录**） |
| A图 / 详情图 | 主图第 2 张、A+ 首图，直接内嵌进单元格 |
| Fitment Bar | 页面左上角 Amazon Confirmed Fit 区块**有无**（输出「有」/「无」） |
| 类目 | `#nav-subnav` 里的部门入口 |
| 加购 / 卖家 / 库存 / 配送时效 / 配送方式 | Buy Box 与配送区块 |

listing 本身没有的字段（无评价、无 Buy Box、无 A+）会留空并记一条 note，**不会让整行失败**；只有拿不到标题才算失败。

---

## 🚀 两种用法

### 1）无头跑（推荐批量用）

```bash
git clone https://github.com/Ian-nextai/AMZ-Listing-Check.git
cd AMZ-Listing-Check
scripts/setup.sh --check          # 环境自检

# 基础抓取
scripts/run.sh "B0XXXXXXX,B0YYYYYYY" --zip 10010

# 全字段含差评（需要 Amazon 登录态）
scripts/run.sh "B0XXXXXXX" --with-reviews

# 大批量分批（批间清图片缓存，省内存）
scripts/run.sh "B0XX,B0YY,..." --chunk 8 --retry 1
```

产物落在 `~/Downloads/amazon-listing-check-<时间戳>.xlsx`，机器可读结果在 `amz-last-run.json`。

退出码：`0` 至少一个成功 · `1` 链路错误 · `2` 全部失败 · `3` 差评模式但未登录。

Windows 用原生 PowerShell 入口（驱动已装的 Edge，不用下载 Chromium）：

```powershell
.\scripts\run.ps1 "B0XXXXXXX,B0YYYYYYY"
```

### 2）当普通扩展用

Chrome → `chrome://extensions` → 开发者模式 → **Load unpacked** → 选 `assets/extension` 目录。
popup 里贴 ASIN 列表、勾字段、填邮编，点开始即可。

---

## ⚙️ 常用参数

| 参数 | 说明 |
| --- | --- |
| `--zip 10010` | 配送邮编（Buy Box 需要美国邮编才渲染） |
| `--with-reviews` | 开差评收集（**默认关**，须先登录） |
| `--chunk 8` | 每批 N 个，批间清图片缓存；大批量建议加 |
| `--retry 1` | 失败 ASIN 自动补跑 |
| `--check-login` | 只检测登录态 |
| `--no-images` | 不要图片列 |

差评**默认关闭**：省约 40% 耗时，且必须登录才能拿到。

---

## 🔑 关于登录

不登录也能抓绝大部分字段。只有**差评**需要登录态——Amazon 的评论页有登录墙。

```bash
scripts/run.sh <ASIN> --check-login     # 看 loggedIn 是否为 true
scripts/run.sh --login                  # 打印无头环境的登录指引
```

无头环境下要人工登录的话，走 xvfb + x11vnc + noVNC + 临时隧道，自己进浏览器登；登完正常退出 Chrome 让 cookie 落盘。详见 `docs/runner.md`。

> ⚠️ 登录之后，每次抓取都会以该账号身份访问 Amazon，有账号风控的理论风险，自行权衡。

---

## 🧠 实现上几个关键点

- **图片内嵌**：SheetJS 社区版会忽略 worksheet `!images`，所以 `xlsx-image.js` 手工往 OOXML 里塞 drawing / media / rels / content-type。
- **图片缩略**：Amazon 原图常 1500px、几百 KB，抓取时就地压到 256px 再进缓存（两 ASIN 的导出从 1.62 MB 降到 58 KB）。
- **图片缓存有上限**：按 URL 缓存，64 MB 封顶、FIFO 淘汰；`--chunk N` 会在批间清空。**失败不写缓存**——否则一次网络抖动会把后续所有 ASIN 的共用图片全部拖垮。
- **解析是纯函数**：`src/core/` 下不碰 chrome API，可以直接在 Node 里单测。
- **扩展固定 ID**：manifest 注入固定 `key`，扩展 ID 恒定，方便 CDP 定位。

`tests/` 覆盖解析与导出，以及 background 的任务生命周期（start / discard / restart / pause）。跑测试：

```bash
node --test tests/*.test.mjs
```

---

## 📁 目录结构

```
assets/extension/         扩展本体（可直接 Load unpacked）
  background.js           service worker：任务循环、导航、抓取、导出
  popup.html / popup.js   输入、勾选、进度
  runner.html / runner.js 存活页（popup 关了也不影响）
  src/core/               纯函数：解析、导出布局、图片、任务状态
scripts/                  一键运行栈（零 npm 依赖）
  run.sh / run.ps1        一条龙入口
  drive.mjs / cdp.mjs     CDP 驱动（自写，无依赖）
  setup.sh                环境自检
docs/runner.md            无头运行与登录实操
```

---

## 🤝 关于

我是 Ian，这套东西是自己业务里跑通之后才搬出来的。
开源出来如果对你有帮助，给个 ⭐ 就行。有问题或建议在 Issues / Discussions 里说一声。

---

MIT License · 自由使用 / 修改 / 再分发

Made by @Ian-nextai
