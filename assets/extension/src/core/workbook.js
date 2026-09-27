import * as XLSX from "../../vendor/xlsx.mjs";
import { getActiveColumns } from "./export-plan.js";
import { embedImagesIntoXlsx } from "./xlsx-image.js";

// Rows carrying images need to be tall enough for the anchors to be visible.
export const IMAGE_ROW_HEIGHT_POINTS = 95;

// Builds the workbook from data that is JSON-safe (rows plus base64 image
// placements). It lives in its own module because the offscreen document runs
// it: extension messaging is JSON-serialized, so a finished workbook cannot be
// handed across contexts as bytes — only the inputs can.
export function createWorkbookBytes(rows, imagePlacements, selectedChecks) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const columns = getActiveColumns(selectedChecks);

  worksheet["!cols"] = columns.map((column) => ({ wch: column.width || 20 }));

  if (imagePlacements.length) {
    const imageColumnIndexes = columns
      .map((column, index) => (column.key === "imageA" || column.key === "imageDetail" ? index : -1))
      .filter((index) => index >= 0);

    worksheet["!rows"] = rows.map((row, rowIndex) =>
      rowIndex === 0 || !imageColumnIndexes.length ? {} : { hpt: IMAGE_ROW_HEIGHT_POINTS }
    );
  }

  XLSX.utils.book_append_sheet(workbook, worksheet, "Amazon Listing Checks");
  const buffer = XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx"
  });

  if (!imagePlacements.length) {
    return new Uint8Array(buffer);
  }

  return embedImagesIntoXlsx(new Uint8Array(buffer), imagePlacements);
}
