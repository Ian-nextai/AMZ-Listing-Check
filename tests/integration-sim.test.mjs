import test from "node:test";
import assert from "node:assert/strict";

import { extractAmazonListingChecks } from "../amazon-listing-check-extension/src/core/amazon-parser.js";
import { buildImagePlacements, buildWorksheetRows } from "../amazon-listing-check-extension/src/core/export-plan.js";
import {
  createTask,
  recordTaskFailure,
  recordTaskSuccess
} from "../amazon-listing-check-extension/src/core/task-state.js";

const SAMPLE_SUCCESS_HTML = `
<div id="titleSection">
  <h1 id="title"><span id="productTitle">Marsram Ignition Coil Pack UF596</span></h1>
  <div class="a-section dp-title-differentiators">
    <span class="a-size-base a-color-secondary">Double Iridium Spark Plug 4912</span>
  </div>
</div>
<div id="averageCustomerReviews_feature_div">
  <span id="acrPopover" title="4.5 out of 5 stars"></span>
  <span id="acrCustomerReviewText" aria-label="3,498 Reviews">(3,498)</span>
</div>
<div id="feature-bullets">
  <ul>
    <li><span class="a-list-item">Fitment one</span></li>
    <li><span class="a-list-item">Fitment two</span></li>
  </ul>
</div>
<div id="altImages">
  <ul>
    <li class="imageThumbnail variant-MAIN"><img src="https://m.media-amazon.com/images/I/41aaaaaaa_L._AC_US40_.jpg"></li>
    <li class="imageThumbnail variant-PT01"><img src="https://m.media-amazon.com/images/I/41bbbbbbb_L._AC_US40_.jpg"></li>
  </ul>
</div>
<div id="productDescription">
  <img src="https://m.media-amazon.com/images/I/51MaYOvFSTL._AC_SL1200_.jpg">
</div>
<a class="nav-a nav-b" aria-label="Automotive">
  <span class="nav-a-content">Automotive</span>
</a>
<input id="add-to-cart-button" type="submit" value="Add to cart">
<div id="sellerProfileTriggerId">U.S. Based seller</div>
`;

test("simulated integration flow produces export-ready rows", () => {
  const selectedChecks = {
    title: true,
    titleHighlight: true,
    rating: true,
    bulletPoints: true,
    imageA: true,
    imageDetail: true,
    category: true,
    addToCart: true,
    seller: true
  };

  let task = createTask(["B0CKWX6W1L", "B012345678"], selectedChecks);
  const extractedChecks = extractAmazonListingChecks(SAMPLE_SUCCESS_HTML, selectedChecks);
  task = recordTaskSuccess(task, "B0CKWX6W1L", {
    ...extractedChecks,
    imageAData: { base64: "AAAA", extension: "jpg" },
    imageDetailData: { base64: "BBBB", extension: "jpg" }
  });
  task = recordTaskFailure(task, "B012345678", "遇到 Amazon Robot Check 页面。");

  const results = task.allAsins.map((asin) => task.resultsByAsin[asin]);
  const rows = buildWorksheetRows(results, selectedChecks);

  assert.deepEqual(rows, [
    ["ASIN", "Status", "Error", "Title", "Highlight", "Rating", "Rating Count", "BP", "A图", "详情图", "Category", "Add To Cart", "Seller"],
    [
      "B0CKWX6W1L", "success", "", "Marsram Ignition Coil Pack UF596", "Double Iridium Spark Plug 4912",
      "4.5", "3498", "Fitment one\nFitment two", "", "", "Automotive", "true", "U.S. Based seller"
    ],
    ["B012345678", "failed", "遇到 Amazon Robot Check 页面。", "", "", "", "", "", "", "", "", "", ""]
  ]);

  assert.deepEqual(
    buildImagePlacements(results, selectedChecks).map((item) => [item.cell, item.base64, item.extension]),
    [
      ["I2", "AAAA", "jpg"],
      ["J2", "BBBB", "jpg"]
    ]
  );
});
