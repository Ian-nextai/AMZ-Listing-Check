// 校验 xlsx 表头：断言本次启用的检查项对应的列都在。
// 注意：vendor/xlsx.mjs 是 SheetJS 的浏览器构建，它的 readFile() 是桩函数
// （抛 "Cannot access file <path>"，因为浏览器里没有 fs）。所以这里用 node:fs
// 自己读字节，再交给 XLSX.read 解析。
// 用法: node check-xlsx-header.mjs <file.xlsx> [必需列,逗号分隔]
// 退出码: 0=全部存在  1=缺列  2=读不了文件
import { readFileSync } from "node:fs";
import * as XLSX from "../assets/extension/vendor/xlsx.mjs";

const [file, requiredArg] = process.argv.slice(2);
if (!file) {
  console.error("用法: node check-xlsx-header.mjs <file.xlsx> [必需列,逗号分隔]");
  process.exit(2);
}

let header;
try {
  const workbook = XLSX.read(new Uint8Array(readFileSync(file)), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  header = (rows[0] || []).map((cell) => String(cell ?? "").trim());
} catch (error) {
  console.error(`无法读取 ${file}: ${error.message}`);
  process.exit(2);
}

const required = String(requiredArg || "").split(",").map((s) => s.trim()).filter(Boolean);
const missing = required.filter((label) => !header.includes(label));

if (missing.length) {
  console.error(`产物表头缺列: ${missing.join(", ")}`);
  console.error(`实际表头(${header.length} 列): ${header.join(" | ")}`);
  process.exit(1);
}

console.log(`HEADER_OK ${header.length} 列: ${header.join(" | ")}`);
