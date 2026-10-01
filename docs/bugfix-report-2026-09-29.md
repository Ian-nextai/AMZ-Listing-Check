# AMZ-Listing-Check 缺陷分析与修复报告

日期：2026-09-29
代码位置：`/root/AMZ-CHECK`（工作副本）、`/root/.hermes/skills/devops/amazon-listing-check`（已安装 skill）
验证规模：405 个 ASIN 真实抓取

---

## 缺陷一：详情图批量丢失（负缓存毒化）

### 1. 现象

405 个 ASIN 的批量抓取中，**A图 808/808 全部拿到，详情图只有 402/808（49.8%）**。

分布极具特征性：批 1–22 详情图完整；批 23 起断崖式归零，批 31–51 连续 21 个批次详情图数为 0；期间偶有批 26/27/30 部分恢复（3/8、5/8、3/8）。

### 2. 排查过程（逐层排除）

| 排查层 | 方法 | 结论 |
| --- | --- | --- |
| 数据真实性 | 检查缺失 ASIN 的 `status` | 全部 `success`，非抓取失败 |
| 解析层 | 用真实浏览器（CDP）抓取页面 HTML（1.6–2.0 MB），喂给 `extractDetailImages()` | 提取出 **13 张**详情图 URL → 解析正常 |
| 网络层 | 对 A+ 图片 URL 逐 host 用 curl / 浏览器内 fetch 实测 | `images-na` / `images-fe` / `images.amazon.com` 均 200 → 网络可达 |
| 缓存层 | 检查 `fetchListingImage` 的缓存写入逻辑 | **命中根因** |

补充说明：curl 直接请求 Amazon 只能拿到 1.3 KB 的精简页（无 A+ 内容），必须用真实浏览器才能复现完整页面——这一步是排查的关键，否则会误判为"页面没有详情图"。

### 3. 根因

`assets/extension/background.js` 的 `fetchListingImage()`：

```js
if (!imageCache.has(target)) {
  imageCache.set(target, await fetchImageAsBase64(target, undefined, { maxEdge: maxImageEdge }));
}
return imageCache.get(target);
```

下载失败时 `fetchImageAsBase64` 返回 `null`，**这个 `null` 被原样写入 `imageCache`**，形成**无过期时间的负缓存**。

而 Amazon 的 A+ 详情图里常有一张**全店共用的 banner**。实测 6 个 ENA 商品中 5 个共用同一个资源 ID：

```
aplus-media-library-service-media/93650185-1a3e-4d7c-a53c-79b3e0be454c
```

于是形成如下连锁：

1. 某次瞬时网络抖动 → 该共用 URL 下载失败
2. `null` 被写入缓存（永不失效）
3. 后续**每一个** ASIN 的详情图 URL 都命中这个 `null`
4. 详情图整批全空，且 `status` 仍为 `success`

这精确解释了"前几批正常、之后断崖归零"以及"偶发批次部分恢复"（缓存被 `drainImageCache` 清空后短暂自愈，随后再次被毒化）。

### 4. 修复

```js
// 失败不再写缓存
if (imageCache.has(target)) {
  return imageCache.get(target) || null;
}

const payload = await fetchImageAsBase64(target, undefined, { maxEdge: maxImageEdge });
if (payload) {
  imageCache.set(target, payload);
  return payload;
}

return null;
```

只有成功才写缓存；失败时返回 `null` 但不落缓存，下次重新尝试即自愈。

### 5. 验证

- **单点验证**：取上次详情图 0/8 的批 31 全部 8 个 ASIN 重跑 → **详情图 8/8**
- **全量验证**：405 个 ASIN 完整重跑 → **详情图 405/405 = 100%**（修复前 49.8%），51 个批次无一缺失
- **回归测试**：新增 `tests/detail-image-cache.test.mjs`（4 项），覆盖"失败不写缓存""一次抖动不毒化后续""成功仍缓存复用""空 URL 处理"
- **全量测试**：153 项通过 / 0 失败

### 6. 判定手法（便于日后快速识别）

按批统计 drawing xml 的锚定列：`<col>11</col>` 为 A图，`<col>12</col>` 为详情图。若出现"A图全满、详情图从某批起断崖归零"且缺失行 `status` 仍为 `success`，即为本缺陷。

---

## 缺陷二：`run.sh` 报 `XLSX_LIST: unbound variable`

### 1. 现象

批量抓取（82 个、405 个）结束后，`run.sh` 输出：

```
REPORT=/root/.hermes/cache/scratch/amz-last-run.json
scripts/run.sh: line 154: amazon-listing-check-2026-09-29T05-57-35-923Z.xlsx: command not found
XLSX:
scripts/run.sh: line 152: XLSX_LIST: unbound variable
EXIT=1
```

**抓取本身完全成功**（405/405，51 个文件全部落盘），仅收尾阶段崩溃，退出码 1，容易被误判为任务失败。

### 2. 根因

`run.sh` 用 `eval` 把 Python 的输出当作 shell 赋值语句执行，其中包含一条超长赋值：

```bash
print('XLSX_LIST="%s"' % ' '.join(r.get('xlsxFiles') or ...))
```

批量运行时几十个文件名被拼接成**一个 2700+ 字符的字符串**再交给 `eval` 解析。该字符串经过 `python3 -c "..."`、`$(...)` 命令替换、`eval` 三层传递，**引号在传递中丢失**，导致 shell 把它解析为：

```
XLSX_LIST=<第一个文件名>    ← 赋值（未加引号，只吃到第一个词）
<第二个文件名>              ← 被当作命令执行 → "command not found"
```

第一条报错 `amazon-listing-check-...xlsx: command not found`（第二个文件名被当命令）正是证据。赋值被破坏后 `XLSX_LIST` 虽被赋值但实际语义错乱，随后 `set -u` 下引用触发 `unbound variable`。

**为什么单批不复现**：单个文件名时字符串短、无空格，`eval` 解析不出歧义——这解释了为何小批量测试从未暴露此问题。

### 3. 修复

不再让文件名列表流经 `eval`。改为 Python 逐行写入临时文件，shell 侧按行读取，彻底绕开引号与词分割问题：

```bash
XLSX_LIST_FILE=$(mktemp)
eval "$(XLSX_LIST_FILE="$XLSX_LIST_FILE" python3 -c "
...
with open(os.environ['XLSX_LIST_FILE'], 'w') as _h:
    for _n in (r.get('xlsxFiles') or ...):
        if _n:
            _h.write(str(_n) + chr(10))
...
")"

# 消费方：按行读，不依赖 shell 词分割
while IFS= read -r name; do echo "  $DOWNLOADS/$name"; done < "$XLSX_LIST_FILE"
```

同时修正两处附带问题：
- `--no-images` 分支设置的 `NO_IMAGES` 未纳入初始化列表（第 28 行），在 `set -u` 下不带该参数时存在隐患 → 补充初始化
- 临时文件清理由 `--feishu` 分支内移到无条件清理，避免非飞书路径残留临时文件

### 4. 验证

- `bash -n` 语法检查通过
- 8 个 ASIN 单批跑：**EXIT=0**，文件列表正常打印
- 20 个 ASIN / `--chunk 4`（产生 5 个批文件）多文件场景：**EXIT=0**，5 个文件全部正确列出，无 `unbound variable`、无 `command not found`
- 已同步至 `/root/AMZ-CHECK/scripts/run.sh`，行数一致

---

## 附：同期修复（前序问题）

**缺陷三：图片 CDN 域名单点故障**（2026-09-28）

本机到 `m.media-amazon.com` 的 TLS 握手被 RST（同 IP 换 SNI 实测：`m.media-amazon.com` → `errno=104`，`images-na` / `images-fe` / `images.amazon.com` → TLSv1.3 正常）。扩展写死从 `colorImages` 的 `hiRes` 取该域名，失败被静默 catch，导致图列全空但行仍 `success`。

修复：`image-fetch.js` 增加 `imageUrlCandidates()` + 回退链（原域名优先，路径与查询串不变）；manifest 补充 `images-fe` host 权限。新增 6 项测试。

---

## 汇总

| 缺陷 | 影响 | 状态 | 验证 |
| --- | --- | --- | --- |
| 详情图负缓存毒化 | 详情图 49.8% → 丢失过半 | 已修复 | 405/405 = 100% |
| run.sh `XLSX_LIST` unbound | 收尾崩溃，退出码 1 | 已修复 | EXIT=0，多批场景通过 |
| 图片 CDN 单点故障 | 图列全空 | 已修复 | 图片正常内嵌 |

测试：全量 **153 项通过 / 0 失败**（含新增 4 项回归测试）。
产物：`/root/Downloads/amazon-listing-check-405ASIN-fixed-20260929-1440.xlsx`（405 行 × 18 列，808 张图，8.3 MB）。
已交付：飞书群。
