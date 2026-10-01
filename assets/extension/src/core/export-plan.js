import { formatReviewEntry } from "./amazon-parser.js";

export const EXPORT_COLUMNS = [  { key: "asin", label: "ASIN", check: null, width: 14 },
  { key: "status", label: "Status", check: null, width: 10 },
  { key: "error", label: "Error", check: null, width: 24 },
  { key: "title", label: "Title", check: "title", width: 50 },
  { key: "titleHighlight", label: "Highlight", check: "titleHighlight", width: 50 },
  { key: "ratingValue", label: "Rating", check: "rating", width: 10 },
  { key: "ratingCount", label: "Rating Count", check: "rating", width: 14 },
  { key: "price", label: "产品价格", check: "price", width: 14 },
  { key: "coupon", label: "优惠券", check: "coupon", width: 40 },
  { key: "discount", label: "折扣", check: "discount", width: 30 },
  { key: "bulletPoints", label: "BP", check: "bulletPoints", width: 70 },
  { key: "stockStatus", label: "库存状态", check: "stockStatus", width: 32 },
  { key: "fitment", label: "Fitment Bar", check: "fitment", width: 12 },
  { key: "deliveryPromise", label: "配送时效", check: "deliveryPromise", width: 40 },
  { key: "fulfilmentRoute", label: "配送方式", check: "fulfilmentRoute", width: 40 },
  { key: "criticalReviews", label: "差评", check: "criticalReviews", width: 80 },
  { key: "imageA", label: "A图", check: "imageA", width: 22 },
  { key: "imageDetail", label: "详情图", check: "imageDetail", width: 22 },
  { key: "categoryName", label: "Category", check: "category", width: 22 },
  { key: "addToCart", label: "Add To Cart", check: "addToCart", width: 14 },
  { key: "sellerName", label: "Seller", check: "seller", width: 24 }
];

export function getActiveColumns(selectedChecks) {
  return EXPORT_COLUMNS.filter(
    (column) => !column.check || Boolean(selectedChecks?.[column.check])
  );
}

export function buildWorksheetRows(results, selectedChecks) {
  const columns = getActiveColumns(selectedChecks);
  const rows = [columns.map((column) => column.label)];

  for (const result of results || []) {
    rows.push(columns.map((column) => formatCellValue(result, column)));
  }

  return rows;
}

export function buildImagePlacements(results, selectedChecks) {
  const columns = getActiveColumns(selectedChecks);
  const imageColumns = {
    imageA: { urlKey: "imageAUrl", dataKey: "imageAData" },
    imageDetail: { urlKey: "imageDetailUrl", dataKey: "imageDetailData" }
  };

  const placements = [];

  (results || []).forEach((result, rowOffset) => {
    columns.forEach((column, columnIndex) => {
      const mapping = imageColumns[column.key];
      if (!mapping) {
        return;
      }

      const url = String(result?.[mapping.urlKey] || "").trim();
      if (!url) {
        return;
      }

      const data = result?.[mapping.dataKey];

      placements.push({
        cell: `${encodeColumnName(columnIndex)}${rowOffset + 2}`,
        url,
        base64: data?.base64 || "",
        extension: data?.extension || "",
        width: 120,
        height: 120
      });
    });
  });

  return placements;
}

export function buildExportFilename(now = new Date()) {
  return `amazon-listing-check-${now.toISOString().replace(/[:.]/g, "-")}.xlsx`;
}

export function encodeColumnName(index) {
  let value = Number(index) + 1;
  let name = "";

  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }

  return name;
}

function formatCellValue(result, column) {
  if (column.key === "addToCart") {
    return formatAddToCartValue(result?.hasAddToCart);
  }

  if (column.key === "bulletPoints") {
    return formatBulletPoints(result?.bulletPoints);
  }

  if (column.key === "criticalReviews") {
    return formatCriticalReviews(result?.criticalReviews);
  }

  if (column.key === "imageA" || column.key === "imageDetail") {
    return "";
  }

  return String(result?.[column.key] ?? "").trim();
}

function formatBulletPoints(value) {
  if (!Array.isArray(value) || !value.length) {
    return "";
  }

  return value.map((item) => String(item || "").trim()).filter(Boolean).join("\n");
}

// Every critical review goes into one cell, numbered in order.
function formatCriticalReviews(value) {
  if (!Array.isArray(value) || !value.length) {
    return "";
  }

  return value
    .map((review, index) => formatReviewEntry(review, index))
    .filter(Boolean)
    .join("\n\n");
}

function formatAddToCartValue(value) {
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  return "";
}
