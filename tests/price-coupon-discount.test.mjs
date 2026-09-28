import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractPrice,
  extractCoupon,
  extractDiscount
} from "../assets/extension/src/core/amazon-parser.js";
import { buildWorksheetRows, getActiveColumns } from "../assets/extension/src/core/export-plan.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name) => fs.readFileSync(path.join(fixturesDir, name), "utf8");

// Captured from live amazon.com listings (signed-in session, US zip 10010).
// Each fixture carries the real price block plus the real coupon block, so the
// three states the columns must distinguish are all represented:
//   price-plain        — nothing but a price
//   price-with-coupon  — a coupon (claim tile + brand promotion)
//   price-with-discount— a percentage discount against a reference price
const PLAIN = readFixture("price-plain.html");
const WITH_COUPON = readFixture("price-with-coupon.html");
const WITH_DISCOUNT = readFixture("price-with-discount.html");

// The coupon block ships several kilobytes of inline JavaScript. A regression
// that reads a container's textContent instead of its visible nodes would
// export that source into the cell, so every value is checked against it.
const SCRIPT_MARKERS = ["P.when(", "function(", "window.", "scriptLoaded", "A.declarative"];

function assertNoScriptLeak(value, label) {
  for (const marker of SCRIPT_MARKERS) {
    assert.ok(
      !String(value || "").includes(marker),
      `${label} must not contain page script source (found ${marker})`
    );
  }
}

test("fixtures are the real captured blocks, not stubs", () => {
  assert.match(PLAIN, /id="corePriceDisplay_desktop_feature_div"/);
  assert.match(WITH_COUPON, /ct-coupon-tile/);
  assert.match(WITH_DISCOUNT, /savingsPercentage/);
});

test("extractPrice returns the buy-box price and not the struck-through reference", () => {
  assert.equal(extractPrice(PLAIN), "$15.99");
  assert.equal(extractPrice(WITH_COUPON), "$16.99");
  // This listing is discounted: the price to pay is $49.99, the reference $54.99.
  assert.equal(extractPrice(WITH_DISCOUNT), "$49.99");
});

test("extractDiscount reports the percentage with its reference price", () => {
  assert.equal(extractDiscount(WITH_DISCOUNT), "-9%（Typical price: $54.99）");
});

// Amazon renders a bare "-" inside a hidden container on listings with no
// discount. That is not a discount, and the cell must stay empty.
test("extractDiscount is empty when the listing has no discount", () => {
  assert.equal(extractDiscount(PLAIN), "");
  assert.equal(extractDiscount(WITH_COUPON), "");
});

test("extractCoupon reports the claim tile and the brand promotion", () => {
  const value = extractCoupon(WITH_COUPON);

  assert.match(value, /Coupon price \$16\.14/);
  assert.match(value, /Saving \$0\.85 at checkout/);
  assert.match(value, /Save 10% with brand promotion N15B9GRN98CF/);
  assertNoScriptLeak(value, "coupon");
});

test("extractCoupon is empty when the coupon block renders empty", () => {
  // Every product page carries the coupon container; on these two it is empty.
  assert.match(PLAIN, /promoPriceBlockMessage_feature_div/);
  assert.equal(extractCoupon(PLAIN), "");
  assert.equal(extractCoupon(WITH_DISCOUNT), "");
});

test("a coupon-only and a discount-only listing never borrow each other's value", () => {
  assert.equal(extractDiscount(WITH_COUPON), "");
  assert.equal(extractCoupon(WITH_DISCOUNT), "");
  assert.notEqual(extractPrice(WITH_COUPON), extractPrice(WITH_DISCOUNT));
});

test("the three columns land next to the rating columns in the export", () => {
  const labels = getActiveColumns({ rating: true, price: true, coupon: true, discount: true })
    .map((column) => column.label);
  const first = labels.indexOf("产品价格");

  assert.deepEqual(labels.slice(first, first + 3), ["产品价格", "优惠券", "折扣"]);
  assert.equal(labels[first - 1], "Rating Count");
});

test("a row exports the captured values and blanks stay blank", () => {
  const results = [
    {
      asin: "B002Y37M0W",
      price: extractPrice(WITH_DISCOUNT),
      coupon: extractCoupon(WITH_DISCOUNT),
      discount: extractDiscount(WITH_DISCOUNT)
    },
    {
      asin: "B0FMQXFWH3",
      price: extractPrice(WITH_COUPON),
      coupon: extractCoupon(WITH_COUPON),
      discount: extractDiscount(WITH_COUPON)
    }
  ];
  const rows = buildWorksheetRows(results, { price: true, coupon: true, discount: true });
  const columns = getActiveColumns({ price: true, coupon: true, discount: true });
  const index = (label) => columns.findIndex((column) => column.label === label);

  assert.equal(rows[1][index("产品价格")], "$49.99");
  assert.equal(rows[1][index("折扣")], "-9%（Typical price: $54.99）");
  assert.equal(rows[1][index("优惠券")], "");
  assert.equal(rows[2][index("产品价格")], "$16.99");
  assert.equal(rows[2][index("折扣")], "");
  assert.match(rows[2][index("优惠券")], /Coupon price \$16\.14/);
});

test("columns are omitted when their check is off", () => {
  const labels = getActiveColumns({ price: false, coupon: false, discount: false })
    .map((column) => column.label);

  assert.ok(!labels.includes("产品价格"));
  assert.ok(!labels.includes("优惠券"));
  assert.ok(!labels.includes("折扣"));
});
