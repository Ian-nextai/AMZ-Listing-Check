import test from "node:test";
import assert from "node:assert/strict";

import {
  isZipCodeAppliedToLocationText,
  normalizeAsins,
  normalizeZipCode
} from "../assets/extension/src/core/task-utils.js";

test("normalizeAsins trims, uppercases, extracts ASINs, and removes duplicates", () => {
  assert.deepEqual(
    normalizeAsins([
      "B0FYP69KJD",
      " https://www.amazon.com/dp/b0fyp69kjd ",
      "asin: b012345678",
      "bad-value"
    ]),
    ["B0FYP69KJD", "B012345678"]
  );
});

test("normalizeZipCode extracts a 5 digit US zip code", () => {
  assert.equal(normalizeZipCode("10010"), "10010");
  assert.equal(normalizeZipCode("10010-1234"), "10010");
  assert.equal(normalizeZipCode(" zip 90210 "), "90210");
  assert.equal(normalizeZipCode("abcd"), "");
});

test("isZipCodeAppliedToLocationText recognizes matching location text", () => {
  assert.equal(isZipCodeAppliedToLocationText("New York 10010", "10010"), true);
  assert.equal(isZipCodeAppliedToLocationText("中国大陆", "10010"), false);
  assert.equal(isZipCodeAppliedToLocationText("", "10010"), false);
});
