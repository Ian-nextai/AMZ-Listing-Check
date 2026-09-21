import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractStockStatus,
  extractDeliveryPromise,
  extractFulfilmentRoute
} from "../amazon-listing-check-extension/src/core/amazon-parser.js";
import { buildWorksheetRows, getActiveColumns } from "../amazon-listing-check-extension/src/core/export-plan.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name) => fs.readFileSync(path.join(fixturesDir, name), "utf8");

// Captured from live amazon.com listings via a signed-in session (US zip 10010).
const IN_STOCK = readFixture("stock-in-stock.html");       // B0CKWX6W1L
const UNAVAILABLE = readFixture("stock-unavailable.html"); // B0FK27RC39

// Guards every stock assertion: the unavailable listing's #availability holds a
// <script>, so a naive textContent read would export JavaScript as the stock value.
const SCRIPT_MARKERS = ["P.when(", "function(", "document.", "var ", "aod-assets-loaded"];

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

test("extractDeliveryPromise reads the delivery wording", () => {
  const promise = extractDeliveryPromise(IN_STOCK);

  assert.ok(promise.length > 0, "in-stock listing should have a delivery promise");
  assert.match(promise.toLowerCase(), /delivery/);
});

test("extractDeliveryPromise returns empty for a listing without one", () => {
  assert.equal(extractDeliveryPromise(UNAVAILABLE), "");
});

test("extractDeliveryPromise never returns script source", () => {
  const promise = extractDeliveryPromise(IN_STOCK);
  for (const marker of SCRIPT_MARKERS) {
    assert.equal(promise.includes(marker), false);
  }
});

test("extractFulfilmentRoute reports who ships and who sells", () => {
  const route = extractFulfilmentRoute(IN_STOCK);

  assert.ok(route.length > 0, "in-stock listing should expose fulfilment info");
  assert.match(route, /Ships from/);
  assert.match(route, /Sold by/);
});

test("extractFulfilmentRoute returns empty when the Buy Box has no offer", () => {
  assert.equal(extractFulfilmentRoute(UNAVAILABLE), "");
});

test("extractFulfilmentRoute omits a missing half rather than printing a placeholder", () => {
  const onlyShipsFrom = `
    <div offer-display-feature-name="desktop-fulfiller-info">
      <span class="offer-display-feature-text-message">Amazon</span>
    </div>`;

  const route = extractFulfilmentRoute(onlyShipsFrom);
  assert.equal(route, "Ships from Amazon");
  assert.equal(route.includes("Sold by"), false);
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
      asin: "B0CKWX6W1L",
      status: "success",
      stockStatus: "In Stock",
      deliveryPromise: "FREE delivery Saturday, September 26",
      fulfilmentRoute: "Ships from Amazon / Sold by Marsram"
    }],
    CHECKS_ALL
  );

  const header = rows[0];
  assert.equal(rows[1][header.indexOf("库存状态")], "In Stock");
  assert.equal(rows[1][header.indexOf("配送时效")], "FREE delivery Saturday, September 26");
  assert.equal(rows[1][header.indexOf("配送方式")], "Ships from Amazon / Sold by Marsram");
});

test("absent new fields export as blank without failing the row", () => {
  const rows = buildWorksheetRows(
    [{ asin: "B0FK27RC39", status: "success", error: "", stockStatus: "", deliveryPromise: "", fulfilmentRoute: "" }],
    CHECKS_ALL
  );

  assert.equal(rows[1][1], "success");
  for (const label of ["库存状态", "配送时效", "配送方式"]) {
    assert.equal(rows[1][rows[0].indexOf(label)], "");
  }
});
