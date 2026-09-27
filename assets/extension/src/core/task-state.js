export const CHECK_KEYS = [
  "title",
  "titleHighlight",
  "rating",
  "bulletPoints",
  "imageA",
  "imageDetail",
  "category",
  "addToCart",
  "seller",
  "criticalReviews",
  "stockStatus",
  "deliveryPromise",
  "fulfilmentRoute"
];

export function createTask(asins, selectedChecks) {
  return {
    allAsins: [...(asins || [])],
    remainingAsins: [...(asins || [])],
    processedAsins: [],
    selectedChecks: normalizeSelectedChecks(selectedChecks),
    resultsByAsin: {},
    status: "idle",
    currentAsin: "",
    progressText: ""
  };
}

export function normalizeSelectedChecks(selectedChecks) {
  const normalized = {};
  for (const key of CHECK_KEYS) {
    normalized[key] = Boolean(selectedChecks?.[key]);
  }
  return normalized;
}

export function hasAnyCheckSelected(selectedChecks) {
  return CHECK_KEYS.some((key) => Boolean(selectedChecks?.[key]));
}

export function recordTaskSuccess(task, asin, extractedChecks) {
  return recordTaskResult(task, asin, {
    asin,
    status: "success",
    error: "",
    title: extractedChecks?.title || "",
    titleHighlight: extractedChecks?.titleHighlight || "",
    ratingValue: extractedChecks?.ratingValue || "",
    ratingCount: extractedChecks?.ratingCount || "",
    bulletPoints: Array.isArray(extractedChecks?.bulletPoints) ? extractedChecks.bulletPoints : [],
    imageAUrl: extractedChecks?.imageAUrl || "",
    imageDetailUrl: extractedChecks?.imageDetailUrl || "",
    imageAData: extractedChecks?.imageAData || null,
    imageDetailData: extractedChecks?.imageDetailData || null,
    imageAError: extractedChecks?.imageAError || "",
    imageDetailError: extractedChecks?.imageDetailError || "",
    categoryName: extractedChecks?.categoryName || "",
    hasAddToCart: extractedChecks?.hasAddToCart ?? null,
    sellerName: extractedChecks?.sellerName || "",
    criticalReviews: Array.isArray(extractedChecks?.criticalReviews) ? extractedChecks.criticalReviews : [],
    reviewPageUrl: extractedChecks?.reviewPageUrl || "",
    reviewsError: extractedChecks?.reviewsError || "",
    stockStatus: extractedChecks?.stockStatus || "",
    deliveryPromise: extractedChecks?.deliveryPromise || "",
    fulfilmentRoute: extractedChecks?.fulfilmentRoute || ""
  });
}

export function recordTaskFailure(task, asin, error) {
  return recordTaskResult(task, asin, {
    asin,
    status: "failed",
    error: String(error || "").trim(),
    title: "",
    titleHighlight: "",
    ratingValue: "",
    ratingCount: "",
    bulletPoints: [],
    imageAUrl: "",
    imageDetailUrl: "",
    imageAData: null,
    imageDetailData: null,
    imageAError: "",
    imageDetailError: "",
    categoryName: "",
    hasAddToCart: null,
    sellerName: "",
    criticalReviews: [],
    reviewPageUrl: "",
    reviewsError: "",
    stockStatus: "",
    deliveryPromise: "",
    fulfilmentRoute: ""
  });
}

export function summarizeTask(task) {
  const results = Object.values(task?.resultsByAsin || {});
  return {
    total: task?.allAsins?.length || 0,
    completed: task?.processedAsins?.length || 0,
    success: results.filter((result) => result?.status === "success").length,
    failed: results.filter((result) => result?.status === "failed").length,
    remaining: task?.remainingAsins?.length || 0
  };
}

// Copies only the three collections that change. A deep clone here would copy
// every already-processed result on every ASIN, which is quadratic in the batch
// size and a real memory spike on a long run; the stored result objects are
// never mutated in place, so sharing them with the previous task is safe.
function recordTaskResult(task, asin, result) {
  return {
    ...task,
    resultsByAsin: { ...task.resultsByAsin, [asin]: result },
    processedAsins: [...task.processedAsins, asin],
    remainingAsins: task.remainingAsins.filter((value) => value !== asin),
    currentAsin: ""
  };
}
