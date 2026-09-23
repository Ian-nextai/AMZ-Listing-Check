// A review's body is truncated to a different length depending on where it was
// scraped (the detail page medley truncates, the all-reviews page does not), so
// identity is keyed on author + date + a title prefix rather than the full body.
export function dedupeReviews(reviews) {
  const byKey = new Map();

  for (const review of reviews || []) {
    if (!review) {
      continue;
    }

    const key = [
      normalizeText(review.author).toLowerCase(),
      normalizeText(review.date).toLowerCase(),
      normalizeText(review.title).slice(0, 40).toLowerCase()
    ].join("|");

    const existing = byKey.get(key);
    if (!existing || String(review.body || "").length > String(existing.body || "").length) {
      byKey.set(key, review);
    }
  }

  return [...byKey.values()];
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
