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

export function extractCategoryName(html) {
  const text = String(html || "");

  const navLabelMatch = text.match(
    /<a[^>]*class="[^"]*\bnav-a\b[^"]*\bnav-b\b[^"]*"[^>]*aria-label="([^"]+)"[^>]*>/i
  );
  if (navLabelMatch?.[1]) {
    return normalizeText(decodeHtml(navLabelMatch[1]));
  }

  const navContentMatch = text.match(
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
    bulletPoints: selectedChecks?.bulletPoints ? bullets : null,
    imageAUrl: selectedChecks?.imageA ? galleryImages[1] || galleryImages[0] || "" : null,
    imageDetailUrl: selectedChecks?.imageDetail ? detailImages[0] || "" : null,
    hasAddToCart: selectedChecks?.addToCart ? hasAddToCartButton(html) : null,
    sellerName: selectedChecks?.seller ? extractSellerName(html) : null,
    criticalReviews: selectedChecks?.criticalReviews ? extractCriticalReviews(html) : null
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
