import { unzipSync, zipSync } from "../../vendor/fflate.js";

const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const EMU_PER_PIXEL = 9525;

// Column letters beyond Z are not needed: the export never exceeds 26 columns.
export function columnToIndex(columnLetters) {
  const letters = String(columnLetters || "").toUpperCase();
  let index = 0;
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

export function buildImageAnchors(images) {
  return (images || [])
    .map((image) => normalizeImageInput(image))
    .filter((image) => image?.bytes?.length && image?.cell)
    .map((image, index) => {
      const match = String(image.cell).match(/^([A-Za-z]+)(\d+)$/);
      if (!match) {
        return null;
      }

      const width = Math.max(1, Math.round(Number(image.width) || 120));
      const height = Math.max(1, Math.round(Number(image.height) || 120));

      return {
        id: index + 1,
        name: `Image ${index + 1}`,
        extension: normalizeExtension(image.extension || "png"),
        bytes: toUint8(image.bytes),
        columnIndex: columnToIndex(match[1]),
        rowIndex: Number(match[2]) - 1,
        width,
        height
      };
    })
    .filter(Boolean);
}

// 已经是 Uint8Array 就原样返回（不复制）。fflate 需要 Uint8Array，而 zipSync
// 只读它，所以这里归一化一次就够了，后续不必再拷贝。
function toUint8(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value || []);
}

function normalizeImageInput(image) {
  if (!image) {
    return null;
  }

  if (image.bytes?.length) {
    return image;
  }

  const base64 = String(image.base64 || "").replace(/^data:[^;]+;base64,/, "");
  if (!base64) {
    return null;
  }

  try {
    return { ...image, bytes: base64ToBytes(base64) };
  } catch (error) {
    return null;
  }
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function buildDrawingXml(anchors) {
  const body = anchors
    .map((anchor) => {
      const extCx = anchor.width * EMU_PER_PIXEL;
      const extCy = anchor.height * EMU_PER_PIXEL;

      return (
        "<oneCellAnchor>" +
        `<from><col>${anchor.columnIndex}</col><colOff>0</colOff>` +
        `<row>${anchor.rowIndex}</row><rowOff>0</rowOff></from>` +
        `<ext cx="${extCx}" cy="${extCy}"/>` +
        "<pic>" +
        `<nvPicPr><cNvPr id="${anchor.id}" name="${anchor.name}" descr="Amazon listing image"/>` +
        "<cNvPicPr/></nvPicPr>" +
        "<blipFill>" +
        `<a:blip xmlns:a="${A_NS}" xmlns:r="${R_NS}" cstate="print" r:embed="rId${anchor.id}"/>` +
        `<a:stretch xmlns:a="${A_NS}"><a:fillRect/></a:stretch>` +
        "</blipFill>" +
        `<spPr><a:prstGeom xmlns:a="${A_NS}" prst="rect"/></spPr>` +
        "</pic>" +
        "<clientData/>" +
        "</oneCellAnchor>"
      );
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><wsDr xmlns="${DRAWING_NS}">${body}</wsDr>`;
}

export function buildDrawingRelsXml(anchors) {
  const body = anchors
    .map(
      (anchor) =>
        `<Relationship Type="${R_NS}/image" Target="/xl/media/image${anchor.id}.${anchor.extension}" Id="rId${anchor.id}"/>`
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELS_NS}">${body}</Relationships>`;
}

export function buildSheetRelsXml() {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELS_NS}">` +
    `<Relationship Type="${R_NS}/drawing" Target="/xl/drawings/drawing1.xml" Id="rId1"/>` +
    "</Relationships>"
  );
}

// SheetJS' community build silently ignores worksheet `!images`, so the drawing
// parts are injected into the generated archive by hand.
export function embedImagesIntoXlsx(xlsxBytes, images) {
  const anchors = buildImageAnchors(images);
  if (!anchors.length) {
    return xlsxBytes;
  }

  // unzipSync 与 zipSync 都只读入参，这里不再复制整包
  const files = unzipSync(toUint8(xlsxBytes));

  for (const anchor of anchors) {
    // level 0 = 仅存储：JPEG/PNG 已经是压缩格式，再 deflate 一遍只多烧一次 CPU
    // 和一份等大的压缩输出缓冲，体积几乎不变
    files[`xl/media/image${anchor.id}.${anchor.extension}`] = [anchor.bytes, { level: 0 }];
  }

  files["xl/drawings/drawing1.xml"] = encode(buildDrawingXml(anchors));
  files["xl/drawings/_rels/drawing1.xml.rels"] = encode(buildDrawingRelsXml(anchors));
  files["xl/worksheets/_rels/sheet1.xml.rels"] = encode(buildSheetRelsXml());

  files["[Content_Types].xml"] = encode(
    addContentTypes(decode(files["[Content_Types].xml"]), anchors)
  );
  files["xl/worksheets/sheet1.xml"] = encode(
    addDrawingReference(decode(files["xl/worksheets/sheet1.xml"]))
  );

  return zipSync(files, { level: 6 });
}

function addContentTypes(xml, anchors) {
  let next = String(xml || "");

  const extensions = [...new Set(anchors.map((anchor) => anchor.extension))];
  for (const extension of extensions) {
    if (next.includes(`Extension="${extension}"`)) {
      continue;
    }
    next = next.replace(
      "</Types>",
      `<Default Extension="${extension}" ContentType="${contentTypeForExtension(extension)}"/></Types>`
    );
  }

  if (!next.includes('PartName="/xl/drawings/drawing1.xml"')) {
    next = next.replace(
      "</Types>",
      '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>'
    );
  }

  return next;
}

function addDrawingReference(xml) {
  const next = String(xml || "");
  if (next.includes("<drawing ")) {
    return next;
  }

  const drawingTag = `<drawing xmlns:r="${R_NS}" r:id="rId1"/>`;
  if (next.includes("</worksheet>")) {
    return next.replace("</worksheet>", `${drawingTag}</worksheet>`);
  }

  return next;
}

function contentTypeForExtension(extension) {
  if (extension === "jpg" || extension === "jpeg") {
    return "image/jpeg";
  }
  if (extension === "gif") {
    return "image/gif";
  }
  if (extension === "bmp") {
    return "image/bmp";
  }
  if (extension === "webp") {
    return "image/webp";
  }
  return "image/png";
}

export function normalizeExtension(value) {
  const extension = String(value || "").toLowerCase().replace(/^\./, "");
  if (extension === "jpeg") {
    return "jpg";
  }
  if (["png", "jpg", "gif", "bmp", "webp"].includes(extension)) {
    return extension;
  }
  return "png";
}

function encode(text) {
  return new TextEncoder().encode(text);
}

function decode(bytes) {
  return new TextDecoder().decode(bytes || new Uint8Array());
}
