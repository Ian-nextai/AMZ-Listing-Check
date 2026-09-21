export function normalizeAsins(values) {
  const seen = new Set();
  const results = [];

  for (const value of values || []) {
    const asin = extractAsin(value);
    if (!asin || seen.has(asin)) {
      continue;
    }

    seen.add(asin);
    results.push(asin);
  }

  return results;
}

export function normalizeZipCode(value) {
  const match = String(value || "").match(/\b(\d{5})(?:-\d{4})?\b/);
  return match?.[1] || "";
}

export function isZipCodeAppliedToLocationText(locationText, zipCode) {
  const normalizedZipCode = normalizeZipCode(zipCode);
  if (!normalizedZipCode) {
    return false;
  }

  return String(locationText || "").includes(normalizedZipCode);
}

function extractAsin(value) {
  const match = String(value || "").toUpperCase().match(/\b[A-Z0-9]{10}\b/g);
  if (!match?.length) {
    return "";
  }

  return match[match.length - 1];
}
