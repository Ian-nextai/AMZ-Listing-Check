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

function recordTaskResult(task, asin, result) {
  const nextTask = structuredClone(task);
  nextTask.resultsByAsin[asin] = result;
  nextTask.processedAsins = [...nextTask.processedAsins, asin];
  nextTask.remainingAsins = nextTask.remainingAsins.filter((value) => value !== asin);
  nextTask.currentAsin = "";
  return nextTask;
}
