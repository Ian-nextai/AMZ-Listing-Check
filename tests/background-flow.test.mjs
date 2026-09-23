import test from "node:test";
import assert from "node:assert/strict";

import {
  createTask,
  hasAnyCheckSelected,
  normalizeSelectedChecks,
  recordTaskFailure,
  recordTaskSuccess,
  summarizeTask
} from "../assets/extension/src/core/task-state.js";

test("task flow tracks remaining items and success summary", () => {
  let task = createTask(["B0FYP69KJD", "B012345678"], {
    title: true,
    bulletPoints: true,
    seller: true
  });

  task = recordTaskSuccess(task, "B0FYP69KJD", {
    title: "Engine Coolant Temperature Sensor",
    bulletPoints: ["Fitment one"],
    sellerName: "U.S. Based seller"
  });
  task = recordTaskFailure(task, "B012345678", "Robot Check");

  assert.deepEqual(summarizeTask(task), {
    total: 2,
    completed: 2,
    success: 1,
    failed: 1,
    remaining: 0
  });
  assert.equal(task.resultsByAsin.B0FYP69KJD.status, "success");
  assert.equal(task.resultsByAsin.B012345678.error, "Robot Check");
});

test("recordTaskSuccess stores the collected listing fields", () => {
  let task = createTask(["B0CKWX6W1L"], { title: true, rating: true, imageA: true, imageDetail: true });

  task = recordTaskSuccess(task, "B0CKWX6W1L", {
    title: "Marsram Ignition Coil Pack",
    titleHighlight: "Double Iridium Spark Plug 4912",
    ratingValue: "4.5",
    ratingCount: "3498",
    bulletPoints: ["Fitment one", "Fitment two"],
    imageAUrl: "https://m.media-amazon.com/images/I/a.jpg",
    imageDetailUrl: "https://m.media-amazon.com/images/I/b.jpg",
    imageAData: { base64: "AAAA", extension: "jpg" },
    imageDetailData: null
  });

  const record = task.resultsByAsin.B0CKWX6W1L;
  assert.equal(record.title, "Marsram Ignition Coil Pack");
  assert.equal(record.titleHighlight, "Double Iridium Spark Plug 4912");
  assert.equal(record.ratingValue, "4.5");
  assert.equal(record.ratingCount, "3498");
  assert.deepEqual(record.bulletPoints, ["Fitment one", "Fitment two"]);
  assert.deepEqual(record.imageAData, { base64: "AAAA", extension: "jpg" });
  assert.equal(record.imageDetailData, null);
});

test("recordTaskFailure blanks every collected field", () => {
  let task = createTask(["B001"], { title: true, bulletPoints: true, imageA: true });
  task = recordTaskFailure(task, "B001", "Robot Check");

  const record = task.resultsByAsin.B001;
  assert.equal(record.title, "");
  assert.equal(record.ratingValue, "");
  assert.deepEqual(record.bulletPoints, []);
  assert.equal(record.imageAData, null);
  assert.equal(record.hasAddToCart, null);
});

test("normalizeSelectedChecks keeps only known check keys as booleans", () => {
  assert.deepEqual(normalizeSelectedChecks({ title: 1, unknown: true }), {
    title: true,
    titleHighlight: false,
    rating: false,
    bulletPoints: false,
    imageA: false,
    imageDetail: false,
    category: false,
    addToCart: false,
    seller: false,
    criticalReviews: false,
    stockStatus: false,
    deliveryPromise: false,
    fulfilmentRoute: false
  });
});

test("hasAnyCheckSelected detects an empty selection", () => {
  assert.equal(hasAnyCheckSelected({}), false);
  assert.equal(hasAnyCheckSelected({ title: false, imageA: false }), false);
  assert.equal(hasAnyCheckSelected({ title: false, imageA: true }), true);
});
