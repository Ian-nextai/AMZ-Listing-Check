import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractStockStatus,
  extractDeliveryPromise,
  extractFulfilmentRoute
} from "../assets/extension/src/core/amazon-parser.js";
import { buildWorksheetRows, getActiveColumns } from "../assets/extension/src/core/export-plan.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name) => fs.readFileSync(path.join(fixturesDir, name), "utf8");

// Captured from live amazon.com listings via a signed-in session (US zip 10010).
const IN_STOCK = readFixture("stock-in-stock.html");       // B07FZ8S74R
const UNAVAILABLE = readFixture("stock-unavailable.html"); // B0D1XD1ZV3
// A merchant-fulfilled listing whose offer slot renders the label
// "Shipper / Seller" instead of a name.
const PLACEHOLDER_SELLER = readFixture("stock-placeholder-seller.html"); // B09B8V1LZ3

// Guards every stock assertion: the unavailable listing's #availability holds a
// <script>, so a naive textContent read would export JavaScript as the stock value.
const SCRIPT_MARKERS = ["P.when(", "function(", "document.", "var ", "aod-assets-loaded"];

// Amazon renders each offer feature twice: an `offer-display-feature-label` node
// holding the heading ("Ships from") and an `offer-display-feature-text` node
// holding the value. Both carry the same feature name, so fixtures must
// reproduce that pairing or they would not exercise the real selector.
function offerFeature(featureName, label, value) {
  return `
    <div class="offer-display-feature-label celwidget" offer-display-feature-name="${featureName}">
      <div class="a-spacing-none"><span class="a-size-small a-color-tertiary">${label}</span></div>
    </div>
    <div class="offer-display-feature-text a-size-small" offer-display-feature-name="${featureName}">
      <div class="offer-display-feature-text a-spacing-none">
        <span class="a-size-small offer-display-feature-text-message">${value}</span>
      </div>
    </div>`;
}

test("fixtures are the real pages, not stubs", () => {
  assert.ok(IN_STOCK.length > 500000, "in-stock fixture should be a full captured page");
  assert.ok(UNAVAILABLE.length > 500000, "unavailable fixture should be a full captured page");
  assert.match(IN_STOCK, /id="availability"/);
  assert.match(UNAVAILABLE, /id="availability"/);
});

test("extractStockStatus reads the stock wording from an in-stock listing", () => {
  assert.equal(extractStockStatus(IN_STOCK), "In Stock");
});

// The unavailable fixture genuinely states its status, so the assertion is that
// the wording is returned — and that the script sitting in the same node is not.
test("extractStockStatus reads the unavailable wording without the script", () => {
  const result = extractStockStatus(UNAVAILABLE);

  assert.match(result, /Currently unavailable/i);
  for (const marker of SCRIPT_MARKERS) {
    assert.equal(result.includes(marker), false, `stock text must not contain ${marker}`);
  }
});

test("extractStockStatus never returns script source when only a script is present", () => {
  const scriptOnly = `
    <div id="availability">
      <script>P.when("A","load").execute("aod-assets-loaded", function(A){ A.$.parseJSON("{}") });</script>
    </div>`;

  assert.equal(extractStockStatus(scriptOnly), "");
});

test("extractStockStatus rejects script markers even when text is present", () => {
  // A node holding both a stock span and an inline script must still yield text only.
  const html = `
    <div id="availability">
      <span class="a-size-medium a-color-success primary-availability-message"> In Stock </span>
      <script>P.when("A","load").execute("aod-assets-loaded", function(A){ A.$.parseJSON("{}") });</script>
    </div>`;

  assert.equal(extractStockStatus(html), "In Stock");
});

test("extractStockStatus collapses whitespace and entities", () => {
  const html = `<div id="availability"><span>  Only   3&nbsp;left   in stock  </span></div>`;
  assert.equal(extractStockStatus(html), "Only 3 left in stock");
});

test("extractStockStatus returns empty when the availability node is absent", () => {
  assert.equal(extractStockStatus("<html><body>nothing</body></html>"), "");
});

test("extractDeliveryPromise reports the standard and Prime delivery times", () => {
  const promise = extractDeliveryPromise(IN_STOCK);

  assert.ok(promise.length > 0, "in-stock listing should have a delivery promise");
  // Both audiences matter: what a normal buyer waits, and what Prime shortens it to.
  assert.match(promise, /普通用户: /, "should label the standard delivery time");
  assert.match(promise, /Prime: /, "should label the Prime delivery time");

  // Times only — no "FREE delivery" boilerplate or cutoff wording.
  assert.equal(/FREE|Order within|Join Prime/i.test(promise), false);
});

test("extractDeliveryPromise keeps the two times distinguishable", () => {
  const promise = extractDeliveryPromise(IN_STOCK);
  const lines = promise.split("\n").filter(Boolean);

  assert.equal(lines.length, 2, "expected one line per audience");
  assert.notEqual(lines[0], lines[1]);
});

test("extractDeliveryPromise never returns script source", () => {
  const promise = extractDeliveryPromise(IN_STOCK);
  for (const marker of SCRIPT_MARKERS) {
    assert.equal(promise.includes(marker), false, `delivery text must not contain ${marker}`);
  }
});

test("extractDeliveryPromise falls back to the standard time when there is no Prime line", () => {
  const standardOnly = `
    <div id="mir-layout-DELIVERY_BLOCK">
      <div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE">
        <span data-csa-c-delivery-time="Sunday, September 27" data-csa-c-delivery-price="FREE">FREE delivery Sunday, September 27</span>
      </div>
    </div>`;

  const promise = extractDeliveryPromise(standardOnly);
  assert.match(promise, /Sunday, September 27/);
  assert.equal(promise.includes("Prime"), false, "no Prime line to report");
});

test("extractDeliveryPromise returns empty for a listing without one", () => {
  assert.equal(extractDeliveryPromise(UNAVAILABLE), "");
});

test("extractFulfilmentRoute reports whatever the page says for Ships from", () => {
  const route = extractFulfilmentRoute(IN_STOCK);

  assert.ok(route.length > 0, "in-stock listing should expose fulfilment info");
  assert.match(route, /^Ships from /, "ships-from comes first");
  assert.equal(route.includes("Sold by"), false, "the route is ships-from only; seller has its own column");
});

test("extractFulfilmentRoute writes the merchant name verbatim", () => {
  // "what the page says" — Amazon, or the seller's own name, are both valid.
  assert.equal(extractFulfilmentRoute(offerFeature("desktop-fulfiller-info", "Ships from", "Some Merchant")), "Ships from Some Merchant");
  assert.equal(extractFulfilmentRoute(offerFeature("desktop-fulfiller-info", "Ships from", "Amazon")), "Ships from Amazon");
});

test("extractFulfilmentRoute prefers the fulfiller over the seller", () => {
  const both =
    offerFeature("desktop-fulfiller-info", "Ships from", "Amazon") +
    offerFeature("desktop-merchant-info", "Sold by", "Marsram");

  assert.equal(extractFulfilmentRoute(both), "Ships from Amazon");
});

// Some merchant-fulfilled listings render no fulfiller slot, only a seller name.
test("extractFulfilmentRoute falls back to the seller when there is no fulfiller slot", () => {
  const sellerOnly = offerFeature("desktop-merchant-info", "Sold by", "czyaoshan");
  assert.equal(extractFulfilmentRoute(sellerOnly), "Ships from czyaoshan");
});

// The B09B8V1LZ3 listing renders these placeholders instead of a name; writing
// either of them into the cell would be inventing data.
test("extractFulfilmentRoute rejects placeholder labels", () => {
  for (const label of ["Shipper / Seller", "Ships from", "Sold by", "Learn more about the seller", "-"]) {
    const html =
      offerFeature("desktop-fulfiller-info", "Ships from", label) +
      offerFeature("desktop-merchant-info", "Sold by", label);

    assert.equal(extractFulfilmentRoute(html), "", `"${label}" must not be reported as a shipper`);
  }
});

test("extractFulfilmentRoute returns empty when the Buy Box has no offer", () => {
  assert.equal(extractFulfilmentRoute(UNAVAILABLE), "");
});

// The real B09B8V1LZ3 page renders no fulfiller slot and shows "Shipper / Seller"
// as the label; the seller name lives in the sibling text node, whose embedded
// state carries this listing's own asin, so it is the correct answer here.
test("extractFulfilmentRoute uses the seller when the listing has no fulfiller slot", () => {
  const route = extractFulfilmentRoute(PLACEHOLDER_SELLER);

  assert.equal(route, "Ships from czyaoshan");
  // The label is a slot heading, never the value.
  assert.equal(/Shipper/i.test(route), false);
});

test("extractStockStatus works on the merchant-fulfilled listing too", () => {
  assert.match(extractStockStatus(PLACEHOLDER_SELLER), /left in stock/i);
});

// --- Export wiring ---

const CHECKS_ALL = { stockStatus: true, deliveryPromise: true, fulfilmentRoute: true };

test("the three new columns appear only when selected", () => {
  const off = getActiveColumns({}).map((c) => c.key);
  for (const key of Object.keys(CHECKS_ALL)) {
    assert.equal(off.includes(key), false, `${key} must be absent when unchecked`);
  }

  const on = getActiveColumns(CHECKS_ALL).map((c) => c.key);
  assert.deepEqual(
    on.filter((k) => Object.keys(CHECKS_ALL).includes(k)),
    ["stockStatus", "deliveryPromise", "fulfilmentRoute"]
  );
});

test("an unchecked new column leaves the exported workbook unchanged", () => {
  const rows = buildWorksheetRows(
    [{ asin: "B000000000", status: "success" }],
    { stockStatus: false, deliveryPromise: false, fulfilmentRoute: false }
  );

  assert.deepEqual(rows[0], ["ASIN", "Status", "Error"]);
});

test("the new columns carry their values into the row", () => {
  const rows = buildWorksheetRows(
    [{
      asin: "B07FZ8S74R",
      status: "success",
      stockStatus: "In Stock",
      deliveryPromise: "普通用户: Saturday, September 26\nPrime: Today 6 PM - 11 PM",
      fulfilmentRoute: "Ships from Amazon"
    }],
    CHECKS_ALL
  );

  const header = rows[0];
  assert.equal(rows[1][header.indexOf("库存状态")], "In Stock");
  assert.equal(rows[1][header.indexOf("配送时效")], "普通用户: Saturday, September 26\nPrime: Today 6 PM - 11 PM");
  assert.equal(rows[1][header.indexOf("配送方式")], "Ships from Amazon");
});

test("absent new fields export as blank without failing the row", () => {
  const rows = buildWorksheetRows(
    [{ asin: "B0D1XD1ZV3", status: "success", error: "", stockStatus: "", deliveryPromise: "", fulfilmentRoute: "" }],
    CHECKS_ALL
  );

  assert.equal(rows[1][1], "success");
  for (const label of ["库存状态", "配送时效", "配送方式"]) {
    assert.equal(rows[1][rows[0].indexOf(label)], "");
  }
});
