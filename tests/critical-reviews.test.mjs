import test from "node:test";
import assert from "node:assert/strict";

import {
  CRITICAL_REVIEW_LIMIT,
  buildAllReviewsUrl,
  buildCriticalReviewsUrl,
  extractAllReviews,
  extractCriticalReviews,
  formatReviewEntry,
  detectSignInPage,
  isSignInUrl
} from "../amazon-listing-check-extension/src/core/amazon-parser.js";
import { buildWorksheetRows } from "../amazon-listing-check-extension/src/core/export-plan.js";

function reviewBlock({ stars, title, body, date = "Reviewed in the United States on January 1, 2026", author = "Someone" }) {
  return `
    <div data-hook="review">
      <div data-hook="review-star-rating"><span class="a-icon-alt">${stars} out of 5 stars</span></div>
      <a href="/x"><h5 data-hook="reviewTitle" lang="en-US">${title}</h5></a>
      <div data-hook="review-by-line">
        <span data-hook="review-date" class="a-size-base a-color-tertiary">${date}</span>
      </div>
      <span class="a-profile-name">${author}</span>
      <div data-hook="reviewTextContainer">
        <div data-hook="reviewRichContentContainer">
          <span>${body}</span>
          <span>Brief content visible, double tap to read full content.Full content visible, double tap to read brief content.</span>
        </div>
      </div>
    </div>
  `;
}

const MIXED_REVIEWS_HTML = [
  reviewBlock({ stars: 5, title: "Great", body: "Works well", author: "Alice" }),
  reviewBlock({ stars: 1, title: "Broke fast", body: "Failed in a month", author: "Bob" }),
  reviewBlock({ stars: 4, title: "Decent", body: "Good enough", author: "Carol" }),
  reviewBlock({ stars: 2, title: "Poor fit", body: "Did not fit", author: "Dave" })
].join("");

// The all-reviews page (reached via filterByStar=critical) uses hyphenated
// hooks and a different body container than the detail page medley.
function reviewsPageBlock({ stars, title, body, date = "Reviewed in the United States on March 3, 2026", author = "Someone" }) {
  return `
    <div data-hook="review" class="review aok-relative"><span class="a-list-item">
      <div id="customer_review-R1" class="a-section celwidget">
        <div data-hook="genome-widget"><a class="a-profile">
          <div class="a-profile-content"><span class="a-profile-name">${author}</span></div>
        </a></div>
        <div class="a-row"><h5><a data-hook="review-title" class="a-size-base review-title" href="/x">
          <i data-hook="review-star-rating" class="a-icon a-icon-star a-star-3 review-rating">
            <span class="a-icon-alt">${stars} out of 5 stars</span>
          </i><span class="a-letter-space"></span> <span>${title}</span>
        </a></h5></div>
        <span data-hook="review-date" class="a-size-base review-date">${date}</span>
        <div class="a-row review-data">
          <span data-hook="review-body" class="a-size-base review-text review-text-content">
            <span>${body}</span>
          </span>
        </div>
      </div>
    </span></div>
  `;
}

const REVIEWS_PAGE_HTML = [
  reviewsPageBlock({ stars: "3.0", title: "Package was nice", body: "Had a misfire after install", author: "Kellyreuland" }),
  reviewsPageBlock({ stars: "1.0", title: "Failed fast", body: "Died in a month", author: "Dana" }),
  reviewsPageBlock({ stars: "5.0", title: "Perfect", body: "No issues", author: "Eve" })
].join("");

test("extractCriticalReviews handles the all-reviews page markup", () => {
  const reviews = extractCriticalReviews(REVIEWS_PAGE_HTML);

  assert.deepEqual(reviews.map((r) => r.title), ["Package was nice", "Failed fast"]);
  assert.deepEqual(reviews.map((r) => r.stars), [3, 1]);
  assert.equal(reviews[0].author, "Kellyreuland");
  assert.equal(reviews[0].body, "Had a misfire after install");
  assert.equal(reviews[0].date, "Reviewed in the United States on March 3, 2026");
});

test("extractCriticalReviews handles both page layouts in one document", () => {
  const combined = MIXED_REVIEWS_HTML + REVIEWS_PAGE_HTML;
  const reviews = extractCriticalReviews(combined);

  assert.equal(reviews.length, 4);
  assert.deepEqual(reviews.map((r) => r.stars), [1, 2, 3, 1]);
});

test("buildCriticalReviewsUrl splices the asin into the portal reviews url", () => {
  assert.equal(
    buildCriticalReviewsUrl("B0CKWX6W1L"),
    "https://www.amazon.com/portal/customer-reviews/B0CKWX6W1L/ref=cm_cr_getr_d_show_all?reviewerType=all_reviews&filterByStar=critical#reviews-filter-bar"
  );
});

test("buildCriticalReviewsUrl upper-cases the asin and rejects empty input", () => {
  assert.match(buildCriticalReviewsUrl("b0ckwx6w1l"), /customer-reviews\/B0CKWX6W1L\//);
  assert.equal(buildCriticalReviewsUrl(""), "");
});

test("buildAllReviewsUrl targets the unfiltered reviews page", () => {
  assert.match(buildAllReviewsUrl("B0CKWX6W1L"), /customer-reviews\/B0CKWX6W1L\/ref=cm_cr_dp_d_show_all_top/);
});

test("isSignInUrl detects the sign-in redirect and captcha page", () => {
  assert.equal(isSignInUrl("https://www.amazon.com/ap/signin?openid.return_to=x"), true);
  assert.equal(isSignInUrl("https://www.amazon.com/errors_page/validateCaptcha?x=1"), true);
  assert.equal(isSignInUrl("https://www.amazon.com/dp/B0CKWX6W1L"), false);
});

// A signed-in page embeds an /ap/signin link in its account hover tooltip, so
// testing the document body for that path wrongly reports "signed out".
const SIGNED_IN_PAGE_WITH_SIGNIN_LINK = `
<html><head><title>Amazon.com: Customer reviews: Marsram Ignition Coil Pack</title></head>
<body>
  <div id="nav-link-accountList-nav-line-1">Hello, TestUser</div>
  <script>var t = { "signinContent": { "html": "<div id='nav-signin-tooltip'><a href='https://www.amazon.com/ap/signin?openid.return_to=x'>Sign in</a></div>" } };</script>
  <div data-hook="review"><h5 data-hook="reviewTitle">Bad coils</h5></div>
</body></html>`;

const REAL_SIGN_IN_PAGE = `
<html><head><title>Amazon Sign-In</title></head>
<body><form id="ap_signin_form" name="signIn" action="/ap/signin"></form></body></html>`;

test("detectSignInPage does not flag a signed-in page that merely links to sign-in", () => {
  assert.equal(detectSignInPage(SIGNED_IN_PAGE_WITH_SIGNIN_LINK), false);
  // The old body-wide URL test is exactly what produced the false positive.
  assert.equal(isSignInUrl(SIGNED_IN_PAGE_WITH_SIGNIN_LINK), true);
});

test("detectSignInPage recognises the real sign-in screen", () => {
  assert.equal(detectSignInPage(REAL_SIGN_IN_PAGE), true);
  assert.equal(detectSignInPage(REVIEWS_PAGE_HTML), false);
});

test("extractCriticalReviews keeps only one to three star reviews", () => {
  const reviews = extractCriticalReviews(MIXED_REVIEWS_HTML);

  assert.deepEqual(reviews.map((r) => r.title), ["Broke fast", "Poor fit"]);
  assert.deepEqual(reviews.map((r) => r.stars), [1, 2]);
});

test("extractCriticalReviews reads every field of a review", () => {
  const [review] = extractCriticalReviews(MIXED_REVIEWS_HTML);

  assert.deepEqual(review, {
    stars: 1,
    title: "Broke fast",
    body: "Failed in a month",
    date: "Reviewed in the United States on January 1, 2026",
    author: "Bob"
  });
});

test("extractCriticalReviews strips the accessibility teaser text", () => {
  const [review] = extractCriticalReviews(MIXED_REVIEWS_HTML);
  assert.equal(/Brief content visible|Full content visible/.test(review.body), false);
});

test("extractAllReviews keeps every review", () => {
  assert.equal(extractAllReviews(MIXED_REVIEWS_HTML).length, 4);
});

test("extractCriticalReviews honours the limit", () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    reviewBlock({ stars: 1, title: `Bad ${i}`, body: `Body ${i}`, author: `User ${i}` })
  ).join("");

  assert.equal(extractCriticalReviews(many).length, CRITICAL_REVIEW_LIMIT);
});

test("extractCriticalReviews returns an empty list when nothing qualifies", () => {
  const positiveOnly = reviewBlock({ stars: 5, title: "Great", body: "Works" });
  assert.deepEqual(extractCriticalReviews(positiveOnly), []);
});

test("formatReviewEntry numbers the entry and joins its parts", () => {
  const entry = formatReviewEntry(
    { stars: 1, title: "Broke fast", body: "Failed", date: "Reviewed in the United States on May 1, 2026", author: "Bob" },
    0
  );

  assert.equal(entry.split("\n")[0], "#1 1星 Broke fast");
  assert.match(entry, /Bob · Reviewed in the United States on May 1, 2026/);
  assert.match(entry, /Failed/);
});

test("the 差评 column puts every review in one cell", () => {
  const result = {
    asin: "B0CKWX6W1L",
    status: "success",
    criticalReviews: extractCriticalReviews(MIXED_REVIEWS_HTML)
  };

  const rows = buildWorksheetRows([result], { criticalReviews: true });
  const columnIndex = rows[0].indexOf("差评");

  assert.equal(columnIndex, 3);
  assert.equal(rows[0].slice(0, 4).join("|"), "ASIN|Status|Error|差评");

  const cell = rows[1][columnIndex];
  assert.match(cell, /^#1 /);
  assert.match(cell, /\n\n#2 /);
  assert.equal(cell.split("\n\n").length, 2);
});

test("the 差评 column is empty when the check is off or nothing was found", () => {
  const off = buildWorksheetRows([{ asin: "A", status: "success" }], { criticalReviews: false });
  assert.equal(off[0].includes("差评"), false);

  const empty = buildWorksheetRows([{ asin: "A", status: "success", criticalReviews: [] }], { criticalReviews: true });
  assert.equal(empty[1][empty[0].indexOf("差评")], "");
});

// The detail page truncates review bodies, so the same review looks like two
// different entries when merged with the reviews page copy.
test("a review scraped from two pages is not listed twice", async () => {
  const { dedupeReviews } = await import("../amazon-listing-check-extension/src/core/review-dedupe.js");

  const truncated = { stars: 1, title: "2011 Jeep Wrangler", body: "These are the wrong resistance", author: "The Amazin Mike", date: "Reviewed in the United States on January 19, 2025" };
  const full = { stars: 1, title: "2011 Jeep Wrangler", body: "These are the wrong resistance for the 3.8l They work great when cold but as they warm up they stop working and create misfires, these are cheap but I recommend getting OEM replacements", author: "The Amazin Mike", date: "Reviewed in the United States on January 19, 2025" };

  const result = dedupeReviews([truncated, full]);
  assert.equal(result.length, 1, "the same review must collapse to one entry");
  assert.equal(result[0].body, full.body, "the longest body must win");
});

test("distinct reviews by the same author are kept apart", async () => {
  const { dedupeReviews } = await import("../amazon-listing-check-extension/src/core/review-dedupe.js");

  const a = { stars: 1, title: "Bad coils", body: "x", author: "Mike", date: "January 1, 2025" };
  const b = { stars: 2, title: "Different complaint", body: "y", author: "Mike", date: "February 2, 2025" };

  assert.equal(dedupeReviews([a, b]).length, 2);
});
