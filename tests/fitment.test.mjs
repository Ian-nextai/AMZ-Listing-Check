// Fitment（Amazon Confirmed Fit，页面左上角适配区块）解析回归测试。
//
// 关键陷阱：不能靠搜 "partfinder" 判断有没有这个区块 —— 这段 CSS 类名在没有
// 该区块的页面里一样存在（实测 43 处），会导致全部 ASIN 都被误判成「有」。
// 必须用已渲染 widget 上的 data-component-id。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractFitment, hasFitmentWidget } from "../assets/extension/src/core/amazon-parser.js";

const MARKER = 'data-component-id="automotive-pf-primary-view"';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 真实页面样本存在仓库里，测试不依赖 /tmp（否则重跑或换机器就会 skip）。
// present: B00FLYWNYQ（有该区块）  absent: B07FZ8S74R（没有）
const HAS_FIT = path.join(HERE, "fixtures", "fitment-present.html");
const NO_FIT = path.join(HERE, "fixtures", "fitment-absent.html");
const hasSample = fs.existsSync(HAS_FIT) ? fs.readFileSync(HAS_FIT, "utf8") : "";
const noSample = fs.existsSync(NO_FIT) ? fs.readFileSync(NO_FIT, "utf8") : "";

// 最小的已渲染 widget：只要有 data-component-id 就算「有」
const widgetHtml = (extra = "") => `
  <div data-mix-operations="x" data-component-id="automotive-pf-primary-view"
       data-csa-c-content-id="automotive-pf-primary-view-partfinder-product-dropdown-button">
    <img id="automotive-pf-primary-view-confirmed-fit-icon" src="x.png">
    ${extra}
  </div>`;

test("hasFitmentWidget 只认已渲染的 widget，不认 CSS 里的类名", () => {
  assert.equal(hasFitmentWidget(widgetHtml()), true);
  // 只有 CSS 中的 partfinder 类名 → 必须判为无
  assert.equal(hasFitmentWidget('<style>._detail-page-desktop-fitment-card_partfinderPrimaryDesktopProduct_x{}</style>'), false);
  assert.equal(hasFitmentWidget(""), false);
  assert.equal(hasFitmentWidget("<div>plain listing</div>"), false);
});

test("extractFitment 输出二值：有 / 无", () => {
  assert.equal(extractFitment(widgetHtml()), "有");
  // 显示「不相符」也算有这个块 —— 要的是 bar 本身，不是适配结果
  assert.equal(extractFitment(widgetHtml('<span id="automotive-pf-primary-view-no-this-does-not-fit-message">! This does not fit</span>')), "有");
  assert.equal(extractFitment(widgetHtml('<span class="a-button-text">2004 Honda Civic</span>')), "有");
  // 没有该区块 → 明确输出「无」，而不是留空（留空会和"没跑这项"混淆）
  assert.equal(extractFitment("<div>plain listing</div>"), "无");
  assert.equal(extractFitment(""), "无");
});

test("真实样本：有 fitment bar 的 ASIN 输出「有」", { skip: !hasSample }, () => {
  assert.equal(hasFitmentWidget(hasSample), true);
  assert.equal(extractFitment(hasSample), "有");
});

test("真实样本：无 fitment bar 的 ASIN 输出「无」（不被 CSS 类名骗到）", { skip: !noSample }, () => {
  assert.equal(hasFitmentWidget(noSample), false);
  assert.equal(extractFitment(noSample), "无");
  // 反证：这个页面里 partfinder 字样其实大量存在，所以绝不能用它判断
  assert.ok(/partfinder/i.test(noSample), "样本里应含 partfinder 字样（用于反证）");
});

test("marker 常量与真实页面一致（换标记时这里会红）", () => {
  assert.match(MARKER, /data-component-id="automotive-pf-primary-view"/);
  if (hasSample) {
    assert.ok(hasSample.includes(MARKER), "真实有-fitment 页面应含该 marker");
  }
  if (noSample) {
    assert.ok(!noSample.includes(MARKER), "真实无-fitment 页面不应含该 marker");
  }
});
