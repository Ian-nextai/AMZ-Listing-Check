export const CRITICAL_REVIEW_LIMIT = 30;

const CRITICAL_STAR_THRESHOLD = 3;

// The "all reviews" page can be reached by splicing the ASIN into its URL
// instead of scrolling and clicking through the detail page.
export function buildCriticalReviewsUrl(asin) {
  const id = String(asin || "").trim().toUpperCase();
  if (!id) {
    return "";
  }

  return `https://www.amazon.com/portal/customer-reviews/${encodeURIComponent(id)}/ref=cm_cr_getr_d_show_all?reviewerType=all_reviews&filterByStar=critical#reviews-filter-bar`;
}

export function buildAllReviewsUrl(asin) {
  const id = String(asin || "").trim().toUpperCase();
  if (!id) {
    return "";
  }

  return `https://www.amazon.com/portal/customer-reviews/${encodeURIComponent(id)}/ref=cm_cr_dp_d_show_all_top?_encoding=UTF8&ie=UTF8&reviewerType=all_reviews`;
}

export function isSignInUrl(url) {
  return /amazon\.[a-z.]+\/ap\/signin|\/ap\/signin|\/errors_page\/validateCaptcha/i.test(String(url || ""));
}

// A signed-out request to a reviews page redirects to the sign-in screen. The
// page title is the reliable signal: a signed-in reviews page carries the
// product name, while unrelated `/ap/signin` links appear all over the normal
// chrome (e.g. the account hover tooltip), so testing the whole document for
// that path would report every signed-in page as signed out.
export function detectSignInPage(html) {
  const text = String(html || "");
  const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  if (/^\s*sign\s*in\s*$/i.test(stripTags(decodeHtml(title)).trim())) {
    return true;
  }

  return /id="ap_signin_form"|name="signIn"|<h1[^>]*>\s*Sign[\s-]?in\s*<\/h1>/i.test(text);
}

// The whole-reviews page needs a signed-in session, but the product page already
// renders a review medley that includes critical ones.
export function extractCriticalReviews(html, limit = CRITICAL_REVIEW_LIMIT) {
  const reviews = [];

  for (const block of splitReviewBlocks(String(html || ""))) {
    const parsed = parseReviewBlock(block);
    if (parsed && Number(parsed.stars) <= CRITICAL_STAR_THRESHOLD) {
      reviews.push(parsed);
    }
    if (reviews.length >= limit) {
      break;
    }
  }

  return reviews;
}

export function extractAllReviews(html, limit = CRITICAL_REVIEW_LIMIT) {
  const reviews = [];

  for (const block of splitReviewBlocks(String(html || ""))) {
    const parsed = parseReviewBlock(block);
    if (parsed) {
      reviews.push(parsed);
    }
    if (reviews.length >= limit) {
      break;
    }
  }

  return reviews;
}

export function formatReviewEntry(review, index) {
  const stars = String(review?.stars || "").trim();
  const title = String(review?.title || "").trim();
  const body = String(review?.body || "").trim();
  const date = String(review?.date || "").trim();
  const author = String(review?.author || "").trim();

  const head = [`#${index + 1}`, stars ? `${stars}星` : "", title].filter(Boolean).join(" ");
  const meta = [author, date].filter(Boolean).join(" · ");

  return [head, meta, body].filter(Boolean).join("\n");
}

function splitReviewBlocks(html) {
  const marker = /data-hook="review"/g;
  const blocks = [];
  let match;

  while ((match = marker.exec(html)) !== null) {
    const start = match.index;
    const next = html.indexOf('data-hook="review"', marker.lastIndex);
    blocks.push(html.slice(start, next < 0 ? Math.min(html.length, start + 30000) : next));
  }

  return blocks;
}

function parseReviewBlock(block) {
  const stars = readElementText(block, /data-hook="review-star-rating"[\s\S]{0,400}?<span[^>]*class="a-icon-alt"[^>]*>([\s\S]*?)<\/span>/i)
    || readElementText(block, /class="a-icon-alt"[^>]*>([\s\S]*?)<\/span>/i);
  const starValue = Number((String(stars).match(/([\d.]+)\s*out of 5/i) || [])[1]);

  // The detail page uses `reviewTitle`, the all-reviews page uses
  // `review-title`; bodies are `reviewRichContentContainer` vs `review-body`.
  // Each pattern targets one exact hook so it cannot skip into the body.
  const title = stripReviewNoise(
    readElementText(block, /data-hook="reviewTitle"[^>]*>([\s\S]{0,400}?)<\/h[1-6]>/i)
    || readElementText(block, /data-hook="reviewTitle"[^>]*>([\s\S]{0,400}?)<\/span>/i)
    || readReviewTitleSpans(block)
  );
  const body = stripReviewNoise(
    readElementText(block, /data-hook="review-body"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)
    || readElementText(block, /data-hook="reviewRichContentContainer"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)
    || readElementText(block, /data-hook="review-?[Tt]ext"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)
  );
  const date = stripReviewNoise(
    readElementText(block, /data-hook="review-date"[^>]*>([\s\S]*?)<\/span>/i)
  );
  const author = stripReviewNoise(
    readElementText(block, /class="a-profile-name"[^>]*>([\s\S]*?)<\/span>/i)
  );

  if (!title && !body) {
    return null;
  }

  return {
    stars: Number.isFinite(starValue) ? starValue : "",
    title: normalizeText(title).slice(0, 300),
    body: normalizeText(body).slice(0, 2000),
    date: normalizeText(date).slice(0, 120),
    author: normalizeText(author).slice(0, 80)
  };
}

function readElementText(block, pattern) {
  return normalizeText(stripTags(decodeHtml(block.match(pattern)?.[1] || "")));
}

// The all-reviews title anchor holds a star icon, an empty spacer span and then
// the title span, so the last non-empty span inside the anchor is the title.
function readReviewTitleSpans(block) {
  const anchorMatch = block.match(/data-hook="review-title"[^>]*>([\s\S]{0,1200}?)<\/a>/i);
  if (!anchorMatch?.[1]) {
    return "";
  }

  const spans = [...anchorMatch[1].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)]
    .map((match) => normalizeText(stripTags(decodeHtml(match[1]))))
    .filter(Boolean);

  return spans.length ? spans[spans.length - 1] : "";
}

function stripReviewNoise(value) {
  return String(value || "")
    .replace(/Brief content visible, double tap to read full content\.?/gi, "")
    .replace(/Full content visible, double tap to read brief content\.?/gi, "")
    .replace(/^\s*\d+(\.\d+)? out of 5 stars\s*/i, "")
    .trim();
}

// The department store tab sits in the page's own sub-navigation bar, which
// Amazon only renders for physical-goods departments. Books and other digital
// listings have no #nav-subnav at all, so those legitimately yield nothing.
const NAV_STORE_TAB_PATTERN =
  /<a[^>]*class="[^"]*\bnav-a\b[^"]*\bnav-b\b[^"]*"[^>]*aria-label="([^"]+)"[^>]*>/i;

export function extractCategoryName(html) {
  const text = String(html || "");

  // Read the subnav first: anchoring on it keeps the answer tied to the
  // department the listing is actually filed under, rather than to whichever
  // nav anchor happens to appear first in a full page dump.
  const subnav = readSection(text, "nav-subnav");
  const anchor = readStoreTab(subnav) || readStoreTab(text);
  return anchor && !isScriptSource(anchor) ? anchor : "";
}

function readStoreTab(text) {
  if (!text) {
    return "";
  }

  const labelled = String(text).match(NAV_STORE_TAB_PATTERN);
  if (labelled?.[1]) {
    return normalizeText(decodeHtml(labelled[1]));
  }

  // Newer renders drop the aria-label, leaving the label in a child span.
  const navContentMatch = String(text).match(
    /<a[^>]*class="[^"]*\bnav-a\b[^"]*\bnav-b\b[^"]*"[^>]*>[\s\S]*?<span[^>]*class="[^"]*\bnav-a-content\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i
  );
  return normalizeText(stripTags(decodeHtml(navContentMatch?.[1] || "")));
}

export function extractProductTitle(html) {
  const text = String(html || "");
  const titleMatch =
    text.match(/<span[^>]*id="productTitle"[^>]*>([\s\S]*?)<\/span>/i) ||
    text.match(/<h1[^>]*id="title"[^>]*>([\s\S]*?)<\/h1>/i);

  return normalizeText(stripTags(decodeHtml(titleMatch?.[1] || "")));
}

export function extractTitleHighlight(html) {
  const text = String(html || "");
  const blockMatch = text.match(
    /<div[^>]*class="[^"]*dp-title-differentiators[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );
  if (!blockMatch?.[1]) {
    return "";
  }

  const spanMatches = [
    ...blockMatch[1].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)
  ].map((match) => normalizeText(stripTags(decodeHtml(match[1]))));

  const parts = spanMatches.filter(Boolean);
  return normalizeText(parts.length ? parts.join(" ") : stripTags(decodeHtml(blockMatch[1])));
}

export function extractRatingValue(html) {
  const text = String(html || "");
  const candidates = [
    text.match(/id="acrPopover"[^>]*title="([^"]*)"/i),
    text.match(/id="acrPopover"[^>]*>[\s\S]{0,400}?a-icon-alt[^>]*>\s*([\d.]+) out of 5/i),
    text.match(/a-icon-alt[^>]*>\s*([\d.]+) out of 5 stars/i)
  ];

  for (const match of candidates) {
    const value = extractRatingNumber(match?.[1]);
    if (value) {
      return value;
    }
  }

  return "";
}

export function extractRatingCount(html) {
  const text = String(html || "");
  const match =
    text.match(/id="acrCustomerReviewText"[^>]*>\s*\(?([\d,]+)\)?/i) ||
    text.match(/id="acrCustomerReviewText"[^>]*aria-label="([\d,]+)\s+Reviews?"/i);

  const digits = String(match?.[1] || "").replace(/[^\d]/g, "");
  return digits;
}

export function extractBulletPoints(html) {
  const text = String(html || "");
  const blockMatch = text.match(
    /id="feature-bullets"[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i
  );
  if (!blockMatch?.[1]) {
    return [];
  }

  return collectListItems(blockMatch[1]);
}

export function extractGalleryImages(html) {
  const text = String(html || "");
  const colorImages = parseColorImages(text);
  if (colorImages.length) {
    return colorImages;
  }

  return extractThumbnailImages(text);
}

export function extractDetailImages(html) {
  const text = String(html || "");

  const descriptionImages = collectImageUrls(readSection(text, "productDescription"));
  if (descriptionImages.length) {
    return descriptionImages;
  }

  const aplusImages = [
    ...collectImageUrls(readSection(text, "aplus_feature_div")),
    ...collectImageUrls(readSection(text, "aplusBrandStory_feature_div"))
  ];
  const productImages = aplusImages.filter((url) => /\/images\/S\/aplus-media-library-service-media\//i.test(url));
  return productImages.length ? productImages : aplusImages;
}

export function hasAddToCartButton(html) {
  return /<input[^>]*id="add-to-cart-button"[^>]*>/i.test(String(html || ""));
}

// 汽车配件的「Amazon Confirmed Fit」区块（页面左上角的 fitment bar）。
//
// 判定必须用**已渲染的 widget**（data-component-id 只出现在真正渲染出来的节点
// 上）。不能搜 "partfinder" 关键字：这段 CSS 类名在没有该区块的页面里也存在
// （实测 43 处），靠 HTML 全文搜索会把没有该区块的 ASIN 全部误判成有。
const FITMENT_WIDGET_MARKER = 'data-component-id="automotive-pf-primary-view"';

export function hasFitmentWidget(html) {
  return String(html || "").includes(FITMENT_WIDGET_MARKER);
}

// 只要「有没有这个块」，不关心具体车型与是否相符：有 → "有"，没有 → "无"。
// 注意与别的检查项不同，这一列**有意**对缺失也输出 "无"，而不是留空 —— 用户要
// 的就是这个二值判断，留空会和"没跑这项检查"混淆。
export function extractFitment(html) {
  return hasFitmentWidget(html) ? "有" : "无";
}

// The merchant slot can hold a generic link label instead of the name, so
// `#merchant-trust-info-card` is checked first and placeholders are rejected.
const SELLER_PLACEHOLDER_PATTERN =
  /^(learn more( about the seller)?|see more|about the seller|details?|sold by|ships? from|view (seller|store) profile|seller profile|visit the seller)$/i;

export function extractSellerName(html) {
  const text = String(html || "");
  const sellerPatterns = [
    /<[^>]*id="merchant-trust-info-card"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<[^>]*id="odf-feature-text-desktop-merchant-info"[^>]*>[\s\S]*?<span[^>]*class="[^"]*offer-display-feature-text-message[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    /<[^>]*id="sellerProfileTriggerId"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<[^>]*id="tabular-buybox-truncate-0"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<div[^>]*id="shipFromSoldByAbbreviated_feature_div"[^>]*>[\s\S]*?<span[^>]*>\s*Sold by:\s*<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i,
    /<div[^>]*id="shipsFromSoldBy_feature_div"[^>]*>[\s\S]*?<span[^>]*>\s*Sold by:\s*<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i,
    /<a[^>]*href="[^"]*seller=[^"]*"[^>]*>([\s\S]*?)<\/a>/i
  ];

  for (const pattern of sellerPatterns) {
    const match = text.match(pattern);
    const sellerName = normalizeText(stripTags(decodeHtml(match?.[1] || "")));
    if (sellerName && !isSellerPlaceholder(sellerName)) {
      return sellerName;
    }
  }

  return "";
}

function isSellerPlaceholder(value) {
  return SELLER_PLACEHOLDER_PATTERN.test(String(value || "").trim());
}

export function detectAmazonRobotCheck(html) {
  return /robot check|captcha|enter the characters you see below/i.test(String(html || ""));
}

// Amazon sometimes gates a session behind a "Click the button below to continue
// shopping" form before serving the real page.
export function detectContinueShoppingGate(html) {
  return /click the button below to continue shopping/i.test(String(html || ""));
}

export function detectNoFeaturedOffers(html) {
  return /no featured offers available/i.test(String(html || ""));
}

export function extractAmazonListingChecks(html, selectedChecks) {
  const bullets = selectedChecks?.bulletPoints ? extractBulletPoints(html) : [];
  const galleryImages = selectedChecks?.imageA ? extractGalleryImages(html) : [];
  const detailImages = selectedChecks?.imageDetail ? extractDetailImages(html) : [];

  return {
    categoryName: selectedChecks?.category ? extractCategoryName(html) : null,
    title: selectedChecks?.title ? extractProductTitle(html) : null,
    titleHighlight: selectedChecks?.titleHighlight ? extractTitleHighlight(html) : null,
    ratingValue: selectedChecks?.rating ? extractRatingValue(html) : null,
    ratingCount: selectedChecks?.rating ? extractRatingCount(html) : null,
    price: selectedChecks?.price ? extractPrice(html) : null,
    coupon: selectedChecks?.coupon ? extractCoupon(html) : null,
    discount: selectedChecks?.discount ? extractDiscount(html) : null,
    bulletPoints: selectedChecks?.bulletPoints ? bullets : null,
    imageAUrl: selectedChecks?.imageA ? galleryImages[1] || galleryImages[0] || "" : null,
    imageDetailUrl: selectedChecks?.imageDetail ? detailImages[0] || "" : null,
    hasAddToCart: selectedChecks?.addToCart ? hasAddToCartButton(html) : null,
    sellerName: selectedChecks?.seller ? extractSellerName(html) : null,
    // 未启用该检查项时整个字段都不出现（而不是 null/undefined）：既有的
    // deepStrictEqual 断言按字段全量比对，多一个键就会被打挂。
    ...(selectedChecks?.fitment ? { fitment: extractFitment(html) } : {}),
    criticalReviews: selectedChecks?.criticalReviews ? extractCriticalReviews(html) : null,
    stockStatus: selectedChecks?.stockStatus ? extractStockStatus(html) : null,
    deliveryPromise: selectedChecks?.deliveryPromise ? extractDeliveryPromise(html) : null,
    fulfilmentRoute: selectedChecks?.fulfilmentRoute ? extractFulfilmentRoute(html) : null
  };
}

function collectListItems(blockHtml) {
  const items = [];
  const listItemPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match;

  while ((match = listItemPattern.exec(blockHtml)) !== null) {
    const text = normalizeText(stripTags(decodeHtml(match[1])));
    if (text) {
      items.push(text);
    }
  }

  return items;
}

function collectImageUrls(blockHtml) {
  const source = String(blockHtml || "");
  const urls = [];

  for (const match of source.matchAll(/<img[^>]*>/gi)) {
    const tag = match[0];
    const candidate =
      readAttribute(tag, "data-src") ||
      readAttribute(tag, "data-old-hires") ||
      readAttribute(tag, "src");

    const url = normalizeImageUrl(decodeHtml(candidate));
    if (url) {
      urls.push(url);
    }
  }

  return dedupe(urls);
}

function readSection(html, elementId) {
  const text = String(html || "");
  const openTagMatch = new RegExp(`<div[^>]*id="${elementId}"[^>]*>`, "i").exec(text);
  if (!openTagMatch) {
    return "";
  }

  const start = openTagMatch.index + openTagMatch[0].length;
  return sliceBalancedDivs(text, start);
}

// Inline scripts sit inside several of the regions read below (notably
// #availability), so their source must be removed before any text is taken.
function stripNonTextNodes(html) {
  return String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
}

// Amazon renders an unavailable listing's #availability as a script-only node.
// This guards against exporting that source if a script tag ever survives the
// strip above (for example when the markup is truncated mid-script).
const SCRIPT_SOURCE_PATTERN = /P\.when\(|aod-assets-loaded|function\s*\(|document\.|parseJSON\(/;

function isScriptSource(value) {
  return SCRIPT_SOURCE_PATTERN.test(String(value || ""));
}

export function extractStockStatus(html) {
  const section = readSection(html, "availability");
  if (!section) {
    return "";
  }

  const text = normalizeText(stripTags(decodeHtml(stripNonTextNodes(section))));
  return isScriptSource(text) ? "" : text;
}

// Amazon renders two delivery promises side by side: what a normal buyer waits
// (the "primary" slot) and what Prime shortens it to (the "secondary" slot).
// Buyers comparing suppliers care about both, so both are reported.
export function extractDeliveryPromise(html) {
  const section = readSection(html, "mir-layout-DELIVERY_BLOCK");
  if (!section) {
    return "";
  }

  const standard = readDeliveryTime(section, "PRIMARY_DELIVERY_MESSAGE_LARGE");
  const prime = readDeliveryTime(section, "SECONDARY_DELIVERY_MESSAGE_LARGE");

  const lines = [];
  if (standard) {
    lines.push(`普通用户: ${standard}`);
  }
  if (prime) {
    lines.push(`Prime: ${prime}`);
  }

  return lines.join("\n");
}

// Prefers the structured delivery-time attribute; falls back to the visible
// wording so a layout change does not silently blank the column. Returns "" when
// the slot is absent, so a missing Prime line is never filled from the standard
// one.
function readDeliveryTime(section, slotName) {
  const slot = readSlot(section, slotName);
  if (!slot) {
    return "";
  }

  const attributeMatch = slot.match(/data-csa-c-delivery-time="([^"]*)"/i);
  if (attributeMatch?.[1]) {
    const value = normalizeText(decodeHtml(attributeMatch[1]));
    if (value && !isScriptSource(value)) {
      return value;
    }
  }

  const text = normalizeText(stripTags(decodeHtml(stripNonTextNodes(slot))));
  if (!text || isScriptSource(text)) {
    return "";
  }

  const deliveryMatch = text.match(/(?:FREE\s+)?delivery\s+([^.]{3,60}?)(?:\.|Order within|$)/i);
  return normalizeText(deliveryMatch?.[1] || "");
}

// Reads one delivery slot up to the next slot (or the end of the block), so a
// missing slot yields nothing rather than inheriting its sibling's content.
function readSlot(section, slotName) {
  const openPattern = new RegExp(`<div[^>]*id="[^"]*${slotName}"[^>]*>`, "i");
  const openMatch = openPattern.exec(section);
  if (!openMatch) {
    return "";
  }

  const start = openMatch.index + openMatch[0].length;
  const rest = section.slice(start);

  const nextSlot = rest.search(/<div[^>]*id="[^"]*_DELIVERY_MESSAGE_LARGE"/i);
  const body = nextSlot >= 0 ? rest.slice(0, nextSlot) : rest;

  // Keep to this slot's own subtree; the block can hold unrelated siblings.
  return sliceBalancedDivs(body, 0);
}

// Reports who ships the item exactly as the page states it: "Amazon", or the
// merchant's own name. Most listings expose a fulfiller slot; some
// merchant-fulfilled listings expose only a seller slot, which names the same
// party, so it is used as a fallback.
export function extractFulfilmentRoute(html) {
  const text = String(html || "");
  const shipper =
    readOfferFeature(text, "desktop-fulfiller-info") ||
    readOfferFeature(text, "desktop-merchant-info");

  return shipper ? `Ships from ${shipper}` : "";
}

// Values that name a slot rather than a merchant. The feature markup carries
// both a label node ("Shipper / Seller") and a text node, so a placeholder can
// otherwise be mistaken for the answer.
const OFFER_PLACEHOLDER_PATTERN =
  /^(shipper\s*\/\s*seller|ships? from( and sold by)?|sold by|seller|shipper|learn more( about the seller)?|see more|details?|unknown|-+)$/i;

function isOfferPlaceholder(value) {
  return OFFER_PLACEHOLDER_PATTERN.test(String(value || "").trim());
}

// Reads the *value* node of an offer-display feature. Each feature appears
// twice: once as `offer-display-feature-label` (the heading, e.g. "Ships from")
// and once as `offer-display-feature-text` (the answer). Matching on the shared
// feature name alone would read the heading instead of the value.
function readOfferFeature(text, featureName) {
  const pattern = new RegExp(
    `class="[^"]*offer-display-feature-text[^"]*"[^>]*offer-display-feature-name="${featureName}"` +
    `|offer-display-feature-name="${featureName}"[^>]*class="[^"]*offer-display-feature-text[^"]*"`,
    "i"
  );
  const anchor = pattern.exec(text);
  if (!anchor) {
    return "";
  }

  const openTagEnd = text.indexOf(">", anchor.index + anchor[0].length);
  if (openTagEnd < 0) {
    return "";
  }

  const body = sliceBalancedDivs(text, openTagEnd + 1);
  const messageMatch = body.match(
    /class="[^"]*offer-display-feature-text-message[^"]*"[^>]*>([\s\S]*?)</i
  );
  if (!messageMatch?.[1]) {
    return "";
  }

  const value = normalizeText(stripTags(decodeHtml(stripNonTextNodes(messageMatch[1]))));
  if (!value || isScriptSource(value) || isOfferPlaceholder(value)) {
    return "";
  }

  return value;
}

// ---------------------------------------------------------------------------
// Price / discount / coupon
//
// All three live in the price block. Amazon renders the same value twice — a
// screen-reader `.a-offscreen` span and the visible markup — and leaves the
// offscreen copy blank on some page loads, so the visible pieces are composed
// as a fallback. Values arrive as nested spans, which is why the block is read
// with a balanced-tag walker rather than a fixed-width window.
// ---------------------------------------------------------------------------

const PRICE_SECTION_IDS = [
  "corePriceDisplay_desktop_feature_div",
  "corePrice_feature_div",
  "corePriceDisplay_mobile_feature_div",
  "corePrice_desktop"
];

const COUPON_SECTION_IDS = [
  "promoPriceBlockMessage_feature_div",
  "promoPriceBlockMessage",
  "couponFeature",
  "couponBadge_feature_div",
  "applicablePromotionList_feature_div"
];

function readFirstSection(html, elementIds) {
  for (const elementId of elementIds) {
    const section = readSection(html, elementId);
    if (section) {
      return section;
    }
  }

  return "";
}

// Current buy-box price, e.g. "$49.99". A struck-through reference price is
// never returned: the buy-box value is read from its own wrapper, and the
// reference price lives in `.basisPrice`, outside it.
export function extractPrice(html) {
  const section = stripNonTextNodes(readFirstSection(String(html || ""), PRICE_SECTION_IDS));
  if (!section) {
    return "";
  }

  const payBlock =
    readBalancedByClass(section, "span", "priceToPay") ||
    readBalancedByClass(section, "span", "apexPriceToPay");
  const payPrice = readPriceFromBlock(payBlock);
  if (payPrice) {
    return payPrice;
  }

  // Older layouts have no buy-box wrapper: the first price in the block that is
  // not the struck-through reference is the one to pay.
  for (const match of section.matchAll(/<span[^>]*class="([^"]*\ba-price\b[^"]*)"[^>]*>/gi)) {
    if (/a-text-price|basisPrice|apex-basisprice-value/i.test(match[1])) {
      continue;
    }

    const candidate = readPriceFromBlock(
      sliceBalancedTag(section, match.index + match[0].length, "span")
    );
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

function readPriceFromBlock(block) {
  if (!block) {
    return "";
  }

  const offscreen = collapseWhitespace(
    normalizeText(stripTags(decodeHtml(readFirstMatch(block, /<span class="a-offscreen">([^<]*)<\/span>/i))))
  );
  if (offscreen) {
    return offscreen;
  }

  // Blank offscreen copy: rebuild from the visible symbol / whole / fraction.
  const symbol =
    collapseWhitespace(normalizeText(stripTags(decodeHtml(readFirstMatch(block, /class="a-price-symbol"[^>]*>([^<]*)</i))))) ||
    "$";
  const whole = collapseWhitespace(
    normalizeText(stripTags(decodeHtml(readFirstMatch(block, /class="a-price-whole"[^>]*>([\s\S]*?)<\/span>/i))))
  );
  const fraction = collapseWhitespace(
    normalizeText(stripTags(decodeHtml(readFirstMatch(block, /class="a-price-fraction"[^>]*>([^<]*)</i))))
  );

  if (!whole) {
    return "";
  }

  // `a-price-whole` normally carries its own decimal span ("49."), but not on
  // every layout, so the separator is only added when it is missing.
  const separator = whole.endsWith(".") || !fraction ? "" : ".";
  return `${symbol}${whole}${separator}${fraction}`;
}

// Savings badge next to a reference price, e.g. "-9% (Typical price: $54.99)".
// Amazon writes a bare "-" inside a hidden container when a listing has no
// discount; that is not a discount and yields an empty cell.
export function extractDiscount(html) {
  const section = stripNonTextNodes(readFirstSection(String(html || ""), PRICE_SECTION_IDS));
  if (!section) {
    return "";
  }

  const percent = collapseWhitespace(
    normalizeText(
      stripTags(
        decodeHtml(
          readBalancedByClass(section, "span", "savingsPercentage") ||
            readBalancedByClass(section, "span", "savingPriceOverride")
        )
      )
    )
  );
  const hasPercent = /^-\s*\d+(?:\.\d+)?%$/.test(percent);

  const basisBlock = readBalancedByClass(section, "span", "basisPrice");
  const basisLabel = normalizeText(
    stripTags(decodeHtml(readBalancedByClass(basisBlock, "span", "apex-basisprice-label")))
  );
  const basisValue = collapseWhitespace(
    normalizeText(stripTags(decodeHtml(readFirstMatch(basisBlock, /<span class="a-offscreen">([^<]*)<\/span>/i))))
  );

  const dealBadge = normalizeText(
    stripTags(
      decodeHtml(
        readBalancedByPrefix(section, "span", "dealBadge") ||
          readBalancedByClass(section, "div", "dealBadge") ||
          readBalancedByClass(section, "span", "dealBadge")
      )
    )
  );

  if (!hasPercent && !dealBadge) {
    return "";
  }

  const parts = [];
  if (dealBadge) {
    parts.push(dealBadge);
  }

  if (hasPercent) {
    // The label is Amazon's own wording ("Typical price:", "List Price:") and is
    // kept verbatim so the cell matches what a buyer sees on the page.
    const reference = basisValue && basisLabel ? `${basisLabel} ${basisValue}` : "";
    parts.push(reference ? `${percent}（${reference}）` : percent);
  }

  return parts.join(" ").trim();
}

// Coupons render in three shapes: a classic badge line ("Save 5% with
// coupon"), the newer claim tile ("Coupon price $16.14" / "Saving $0.85 at
// checkout"), and brand promotions ("Save 10% with brand promotion
// N15B9GRN98CF"). Whatever the page carries is reported; an empty coupon block
// (every page has one) yields an empty cell.
export function extractCoupon(html) {
  const page = stripNonTextNodes(String(html || ""));
  const sections = COUPON_SECTION_IDS.map((elementId) => readSection(page, elementId)).filter(Boolean);
  if (!sections.length) {
    return "";
  }

  const scope = sections.join("\n");
  const parts = [];

  for (const pattern of [
    /Save\s+\d+(?:\.\d+)?%\s+with\s+coupon/i,
    /Save\s+\$\s?\d+(?:\.\d+)?\s+with\s+coupon/i,
    /\$\s?\d+(?:\.\d+)?\s+off\s+coupon/i,
    /Apply\s+\$\s?\d+(?:\.\d+)?\s+coupon/i
  ]) {
    const match = scope.match(pattern);
    if (match) {
      parts.push(normalizeText(match[0]));
      break;
    }
  }

  const badge = normalizeText(
    stripTags(
      decodeHtml(
        readBalancedByClass(scope, "div", "couponBadge") ||
          readBalancedByClass(scope, "span", "couponBadge") ||
          readBalancedByClass(scope, "span", "couponLabelText")
      )
    )
  );
  if (badge && /coupon|save|off/i.test(badge)) {
    parts.push(badge);
  }

  const tile = readBalancedByClass(scope, "div", "ct-coupon-tile-container") || scope;
  const couponPrice = readValueAfterLabel(tile, "Coupon price");
  if (couponPrice) {
    parts.push(`Coupon price ${couponPrice}`);
  }
  const saving = readValueAfterLabel(tile, "Saving");
  if (saving) {
    parts.push(`Saving ${saving} at checkout`);
  }

  const promotionLabel = normalizeText(
    stripTags(decodeHtml(readBalancedByPrefix(scope, "label", "greenBadge")))
  );
  const promotionCode = readFirstMatch(scope, /with brand promotion\s+([A-Z0-9]{6,})/i);
  if (promotionLabel && /save/i.test(promotionLabel)) {
    parts.push(promotionCode ? `${promotionLabel} with brand promotion ${promotionCode}` : promotionLabel);
  }

  return dedupe(parts.map((part) => normalizeText(part)).filter(Boolean)).join(" | ");
}

// Reads the price that follows a label inside a coupon tile, e.g. the "$16.14"
// after "Coupon price".
function readValueAfterLabel(block, labelText) {
  const anchor = String(block || "").search(new RegExp(`>\\s*${labelText}\\s*<`, "i"));
  if (anchor < 0) {
    return "";
  }

  return collapseWhitespace(
    normalizeText(
      stripTags(decodeHtml(readFirstMatch(block.slice(anchor), /<span class="a-offscreen">([^<]*)<\/span>/i)))
    )
  );
}

// Balanced subtree of the first `<tag class="... name ...">` element.
function readBalancedByClass(text, tagName, className) {
  const open = new RegExp(`<${tagName}\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`);
  const match = open.exec(String(text || ""));
  if (!match) {
    return "";
  }

  return sliceBalancedTag(text, match.index + match[0].length, tagName);
}

// Balanced subtree of the first element whose id starts with `idPrefix`
// (Amazon suffixes promotional ids with a per-render token).
function readBalancedByPrefix(text, tagName, idPrefix) {
  const open = new RegExp(`<${tagName}\\b[^>]*id="${idPrefix}[^"]*"[^>]*>`, "i");
  const match = open.exec(String(text || ""));
  if (!match) {
    return "";
  }

  return sliceBalancedTag(text, match.index + match[0].length, tagName);
}

function sliceBalancedTag(text, start, tagName) {
  let depth = 1;
  const pattern = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}>`, "gi");
  pattern.lastIndex = start;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    depth += match[0][1] === "/" ? -1 : 1;
    if (depth === 0) {
      return text.slice(start, match.index);
    }
  }

  return text.slice(start, start + 40000);
}

function readFirstMatch(text, pattern) {
  const match = String(text || "").match(pattern);
  return match?.[1] || "";
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, "");
}

function sliceBalancedDivs(text, start) {
  let depth = 1;
  const pattern = /<div\b[^>]*>|<\/div>/gi;
  pattern.lastIndex = start;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    depth += match[0][1] === "/" ? -1 : 1;
    if (depth === 0) {
      return text.slice(start, match.index);
    }
  }

  return text.slice(start, start + 400000);
}

function extractThumbnailImages(text) {
  const blockMatch = text.match(/id="altImages"[\s\S]*?<\/ul>/i);
  if (!blockMatch?.[0]) {
    return [];
  }

  const urls = [];
  for (const listItem of blockMatch[0].matchAll(/<li[^>]*>[\s\S]*?<\/li>/gi)) {
    if (/videoThumbnail|videoBlock/i.test(listItem[0])) {
      continue;
    }

    const srcMatch = listItem[0].match(/<img[^>]*src="([^"]+)"/i);
    const url = upgradeThumbnailUrl(decodeHtml(srcMatch?.[1] || ""));
    if (url) {
      urls.push(url);
    }
  }

  return urls;
}

function dedupe(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function readAttribute(tagHtml, attribute) {
  const match = String(tagHtml || "").match(
    new RegExp(`${attribute}\\s*=\\s*"([^"]*)"`, "i")
  );
  return match?.[1] || "";
}

function normalizeImageUrl(value) {
  const url = String(value || "").trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return "";
  }
  if (/grey-pixel|transparent-pixel|impb\?|spinner|\.gif$/i.test(url)) {
    return "";
  }
  return url;
}

function upgradeThumbnailUrl(value) {
  const url = normalizeImageUrl(value);
  if (!url) {
    return "";
  }

  return url.replace(/\._[^./]+_\.(jpg|jpeg|png)$/i, "._AC_SL1500_.$1");
}

function parseColorImages(html) {
  const text = String(html || "");
  const keyIndex = text.indexOf("'colorImages'");
  if (keyIndex < 0) {
    return [];
  }

  const arrayStart = text.indexOf("[", text.indexOf("parseJSON", keyIndex));
  if (arrayStart < 0) {
    return [];
  }

  const json = sliceBalancedBrackets(text, arrayStart);
  if (!json) {
    return [];
  }

  try {
    const parsed = JSON.parse(decodeHtml(json));
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry) => normalizeImageUrl(entry?.hiRes || entry?.large))
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

function sliceBalancedBrackets(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }

    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return "";
}

function extractRatingNumber(value) {
  const match = String(value || "").match(/([\d.]+)\s*(?:out of 5|颗星|von 5|étoiles)/i);
  return match?.[1] || "";
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
