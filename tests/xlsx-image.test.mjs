import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync } from "../amazon-listing-check-extension/vendor/fflate.js";

import * as XLSX from "../amazon-listing-check-extension/vendor/xlsx.mjs";
import {
  buildDrawingRelsXml,
  buildDrawingXml,
  buildImageAnchors,
  buildSheetRelsXml,
  columnToIndex,
  embedImagesIntoXlsx,
  normalizeExtension
} from "../amazon-listing-check-extension/src/core/xlsx-image.js";

// 1x1 PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

function buildBaseWorkbook() {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["ASIN", "A图", "详情图"],
    ["B001", "", ""]
  ]);
  XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" });
}

test("columnToIndex converts column letters for the export range", () => {
  assert.equal(columnToIndex("A"), 0);
  assert.equal(columnToIndex("I"), 8);
  assert.equal(columnToIndex("Z"), 25);
  assert.equal(columnToIndex("AA"), 26);
});

test("normalizeExtension maps jpeg onto jpg and rejects unknown types", () => {
  assert.equal(normalizeExtension("JPEG"), "jpg");
  assert.equal(normalizeExtension(".png"), "png");
  assert.equal(normalizeExtension("tiff"), "png");
});

test("buildImageAnchors converts base64 payloads into anchored placements", () => {
  const anchors = buildImageAnchors([
    { cell: "B2", base64: PNG_BASE64, extension: "png", width: 120, height: 90 }
  ]);

  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].columnIndex, 1);
  assert.equal(anchors[0].rowIndex, 1);
  assert.equal(anchors[0].extension, "png");
  assert.equal(anchors[0].width, 120);
  assert.equal(anchors[0].height, 90);
  assert.equal(anchors[0].bytes.length > 0, true);
});

test("buildImageAnchors skips placements with no usable payload", () => {
  assert.deepEqual(buildImageAnchors([{ cell: "B2" }, { cell: "bad", base64: PNG_BASE64 }]), []);
});

test("buildDrawingXml anchors each image with EMU extents", () => {
  const anchors = buildImageAnchors([{ cell: "C3", base64: PNG_BASE64, width: 120, height: 120 }]);
  const xml = buildDrawingXml(anchors);

  assert.match(xml, /<from><col>2<\/col><colOff>0<\/colOff><row>2<\/row><rowOff>0<\/rowOff><\/from>/);
  assert.match(xml, /<ext cx="1143000" cy="1143000"\/>/);
  assert.match(xml, /r:embed="rId1"/);
});

test("buildDrawingRelsXml and buildSheetRelsXml target the media parts", () => {
  const anchors = buildImageAnchors([{ cell: "B2", base64: PNG_BASE64, extension: "jpg" }]);

  assert.match(buildDrawingRelsXml(anchors), /Target="\/xl\/media\/image1\.jpg" Id="rId1"/);
  assert.match(buildSheetRelsXml(), /Target="\/xl\/drawings\/drawing1\.xml" Id="rId1"/);
});

test("embedImagesIntoXlsx injects drawing, media and relationship parts", () => {
  const output = embedImagesIntoXlsx(buildBaseWorkbook(), [
    { cell: "B2", base64: PNG_BASE64, extension: "png", width: 120, height: 120 },
    { cell: "C2", base64: PNG_BASE64, extension: "png", width: 120, height: 120 }
  ]);

  const files = unzipSync(new Uint8Array(output));
  const names = Object.keys(files);

  assert.ok(names.includes("xl/media/image1.png"));
  assert.ok(names.includes("xl/media/image2.png"));
  assert.ok(names.includes("xl/drawings/drawing1.xml"));
  assert.ok(names.includes("xl/drawings/_rels/drawing1.xml.rels"));
  assert.ok(names.includes("xl/worksheets/_rels/sheet1.xml.rels"));

  const sheetXml = new TextDecoder().decode(files["xl/worksheets/sheet1.xml"]);
  assert.match(sheetXml, /<drawing[^>]*r:id="rId1"\/>/);

  const contentTypes = new TextDecoder().decode(files["[Content_Types].xml"]);
  assert.match(contentTypes, /PartName="\/xl\/drawings\/drawing1\.xml"/);
});

test("embedImagesIntoXlsx returns the original bytes when there is nothing to embed", () => {
  const base = buildBaseWorkbook();
  const output = embedImagesIntoXlsx(base, []);

  assert.deepEqual(new Uint8Array(output), new Uint8Array(base));
});

test("embedded workbook still reads back its cell values", () => {
  const output = embedImagesIntoXlsx(buildBaseWorkbook(), [
    { cell: "B2", base64: PNG_BASE64, extension: "png" }
  ]);

  const workbook = XLSX.read(output, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  assert.equal(sheet.A2.v, "B001");
  assert.equal(sheet.A1.v, "ASIN");
});
