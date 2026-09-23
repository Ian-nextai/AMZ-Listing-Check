import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExportFilename,
  buildImagePlacements,
  buildWorksheetRows,
  encodeColumnName,
  getActiveColumns
} from "../assets/extension/src/core/export-plan.js";

const ALL_CHECKS = {
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

const SAMPLE_RESULTS = [
  {
    asin: "B0FYP69KJD",
    status: "success",
    error: "",
    title: "Engine Coolant Temperature Sensor",
    titleHighlight: "Double Iridium Spark Plug 4912",
    ratingValue: "4.5",
    ratingCount: "3498",
    bulletPoints: ["Fitment one", "Fitment two"],
    imageAUrl: "https://m.media-amazon.com/images/I/a.jpg",
    imageDetailUrl: "https://m.media-amazon.com/images/I/b.jpg",
    categoryName: "Automotive",
    hasAddToCart: true,
    sellerName: "U.S. Based seller"
  },
  {
    asin: "B000000000",
    status: "failed",
    error: "Robot Check",
    bulletPoints: []
  }
];

test("buildWorksheetRows emits every selected column in a stable order", () => {
  const rows = buildWorksheetRows(SAMPLE_RESULTS, ALL_CHECKS);

  assert.deepEqual(rows[0], [
    "ASIN", "Status", "Error", "Title", "Highlight", "Rating", "Rating Count",
    "BP", "A图", "详情图", "Category", "Add To Cart", "Seller"
  ]);

  assert.deepEqual(rows[1], [
    "B0FYP69KJD", "success", "", "Engine Coolant Temperature Sensor",
    "Double Iridium Spark Plug 4912", "4.5", "3498",
    "Fitment one\nFitment two", "", "", "Automotive", "true", "U.S. Based seller"
  ]);

  assert.deepEqual(rows[2], [
    "B000000000", "failed", "Robot Check", "", "", "", "", "", "", "", "", "", ""
  ]);
});

test("buildWorksheetRows drops unselected columns entirely", () => {
  const rows = buildWorksheetRows(SAMPLE_RESULTS, {
    title: true,
    rating: true,
    imageA: true
  });

  assert.deepEqual(rows[0], ["ASIN", "Status", "Error", "Title", "Rating", "Rating Count", "A图"]);
  assert.deepEqual(rows[1], [
    "B0FYP69KJD", "success", "", "Engine Coolant Temperature Sensor", "4.5", "3498", ""
  ]);
});

test("buildImagePlacements maps images onto their own row and column", () => {
  const results = [
    {
      ...SAMPLE_RESULTS[0],
      imageAData: { base64: "AAAA", extension: "jpg" },
      imageDetailData: { base64: "BBBB", extension: "png" }
    },
    SAMPLE_RESULTS[1]
  ];

  const placements = buildImagePlacements(results, ALL_CHECKS);

  assert.equal(placements.length, 2);
  assert.deepEqual(
    placements.map((item) => [item.cell, item.base64, item.extension, item.width, item.height]),
    [
      ["I2", "AAAA", "jpg", 120, 120],
      ["J2", "BBBB", "png", 120, 120]
    ]
  );
});

test("buildImagePlacements keeps the url so a lost payload can be re-fetched", () => {
  const results = [
    {
      asin: "B001",
      status: "success",
      imageAUrl: "https://m.media-amazon.com/images/I/a.jpg",
      imageAData: null
    }
  ];

  const placements = buildImagePlacements(results, { imageA: true });

  assert.equal(placements.length, 1);
  assert.equal(placements[0].cell, "D2");
  assert.equal(placements[0].url, "https://m.media-amazon.com/images/I/a.jpg");
  assert.equal(placements[0].base64, "");
});

test("buildImagePlacements shifts with the selected column layout", () => {
  const results = [
    {
      asin: "B001",
      status: "success",
      imageDetailUrl: "https://m.media-amazon.com/images/I/b.jpg"
    }
  ];

  const placements = buildImagePlacements(results, { imageDetail: true });
  assert.deepEqual(placements.map((item) => item.cell), ["D2"]);
});

test("buildImagePlacements skips rows with no image url at all", () => {
  const placements = buildImagePlacements(
    [{ asin: "B001", status: "success", imageAData: { base64: "AAAA" } }],
    { imageA: true }
  );

  assert.deepEqual(placements, []);
});

test("getActiveColumns keeps only selected optional columns", () => {
  const columns = getActiveColumns({ category: true }).map((column) => column.key);
  assert.deepEqual(columns, ["asin", "status", "error", "categoryName"]);
});

test("encodeColumnName handles single and multi letter columns", () => {
  assert.equal(encodeColumnName(0), "A");
  assert.equal(encodeColumnName(8), "I");
  assert.equal(encodeColumnName(25), "Z");
  assert.equal(encodeColumnName(26), "AA");
});

test("buildExportFilename returns a timestamped xlsx filename", () => {
  const filename = buildExportFilename(new Date("2026-04-28T01:02:03.000Z"));
  assert.equal(filename, "amazon-listing-check-2026-04-28T01-02-03-000Z.xlsx");
});
