import test from "node:test";
import assert from "node:assert/strict";

import {
  detectNoFeaturedOffers,
  detectAmazonRobotCheck,
  detectContinueShoppingGate,
  extractAmazonListingChecks,
  extractBulletPoints,
  extractCategoryName,
  extractDetailImages,
  extractGalleryImages,
  extractProductTitle,
  extractRatingCount,
  extractRatingValue,
  extractSellerName,
  extractTitleHighlight,
  hasAddToCartButton
} from "../amazon-listing-check-extension/src/core/amazon-parser.js";

const SAMPLE_HTML = `
<!doctype html>
<html>
  <body>
    <header>
      <a
        href="/automotive-auto-truck-replacements-parts/b/?ie=UTF8&node=15684181&ref_=topnav_storetab_auto"
        class="nav-a nav-b"
        aria-label="Automotive"
        tabindex="0"
      >
        <span class="nav-a-content">
          Automotive
        </span>
      </a>
    </header>
    <main>
      <input
        id="add-to-cart-button"
        name="submit.add-to-cart"
        title="Add to Shopping Cart"
        class="a-button-input"
        type="submit"
        value="Add to cart"
      >
      <div id="sellerProfileTriggerId">U.S. Based seller</div>
      <span class="a-size-small a-color-tertiary">Shipper / Seller</span>
    </main>
  </body>
</html>
`;

const AMAZON_SOLD_BY_HTML = `
<div id="nav-subnav" data-category="beauty">
  <a
    href="/Beauty-Makeup-Skin-Hair-Products/b/?ie=UTF8&node=3760911&ref_=topnav_storetab_beauty_sn_fo"
    class="nav-a nav-b"
    aria-label="All Beauty"
    tabindex="0"
  >
    <span class="nav-a-content">All Beauty</span>
  </a>
</div>
<div id="shipFromSoldByAbbreviated_feature_div" class="celwidget">
  <div id="sfsb_accordion_head" class="a-section show-on-unselected sfsb-header-text">
    <div class="a-row">
      <div class="a-column a-span12 a-text-left truncate">
        <span class="a-size-small"> Ships from: </span>
        <span class="a-size-small"> Amazon.com </span>
      </div>
    </div>
    <div class="a-row">
      <div class="a-column a-span12 a-text-left truncate">
        <span class="a-size-small"> Sold by: </span>
        <span class="a-size-small"> Amazon.com </span>
      </div>
    </div>
  </div>
</div>
<input id="add-to-cart-button" type="submit" value="Add to cart">
`;

// Amazon relabels the merchant slot per session: the anchor can carry a
// generic "Learn more about the seller" while the real name sits in
// #merchant-trust-info-card.
const MERCHANT_TRUST_CARD_HTML = `
<div class="offer-display-feature-text a-size-small" offer-display-feature-name="desktop-merchant-info">
  <div class="offer-display-feature-text a-spacing-none odf-truncation-popover aok-inline-block">
    <a href="/gp/help/seller/at-a-glance.html?seller=A27BSZCTM0A4LD"
       id="sellerProfileTriggerId"
       class="a-size-small a-link-normal offer-display-feature-text-message">Learn more about the seller</a>
  </div>
  <span id="merchant-trust-info-card" class="a-size-small offer-display-feature-text-message">Marsram</span>
</div>
`;

const SELLER_PLACEHOLDER_ONLY_HTML = `
<div class="offer-display-feature-text">
  <a href="/gp/help/seller/at-a-glance.html?seller=A27BSZCTM0A4LD"
     id="sellerProfileTriggerId"
     class="a-size-small a-link-normal offer-display-feature-text-message">Learn more about the seller</a>
</div>
`;

const ODF_MERCHANT_SPAN_HTML = `
<div class="offer-display-feature-text a-size-small" offer-display-feature-name="desktop-merchant-info">
  <div class="offer-display-feature-text a-spacing-none odf-truncation-popover aok-inline-block">
    <a href="/gp/help/seller/at-a-glance.html?seller=A27BSZCTM0A4LD"
       id="sellerProfileTriggerId"
       class="a-size-small a-link-normal offer-display-feature-text-message">Marsram</a>
  </div>
</div>
`;

const NO_BUY_BOX_HTML = `
<div id="availability_feature_div"><span class="a-color-price">Currently unavailable.</span></div>
<div id="feature-bullets">
  <ul><li><span class="a-list-item">Fitment one</span></li></ul>
</div>
<div id="titleSection">
  <h1 id="title"><span id="productTitle">ENA Ignition Coil 84005272</span></h1>
</div>
<div id="acrPopover" title="4.6 out of 5 stars"></div>
<span id="acrCustomerReviewText">(9)</span>
<div id="altImages">
  <ul>
    <li class="imageThumbnail variant-MAIN"><img src="https://m.media-amazon.com/images/I/41aaaaaaa_L._AC_US40_.jpg"></li>
    <li class="imageThumbnail variant-PT01"><img src="https://m.media-amazon.com/images/I/41bbbbbbb_L._AC_US40_.jpg"></li>
  </ul>
</div>
<a class="nav-a nav-b" aria-label="Automotive"><span class="nav-a-content">Automotive</span></a>
`;

const TITLE_AND_HIGHLIGHT_HTML = `<div id="title_feature_div" class="celwidget">
  <div id="titleSection" class="a-section a-spacing-none">
    <h1 id="title" class="a-size-medium a-spacing-none">
      <span id="productTitle" class="a-size-medium product-title-word-break">
        Marsram Ignition Coil Pack UF596 Spark Plug for 2009-2017 Toyota Corolla L4
      </span>
    </h1>
    <div class="a-section dp-title-differentiators">
      <!-- Show as comma-separated string -->
      <span class="a-size-base a-color-secondary">
        Double Iridium Spark Plug 4912 Fit for 2010-2015 Toyota Prius Matrix
      </span>
    </div>
  </div>
</div>
`;

const TITLE_WITHOUT_HIGHLIGHT_HTML = `
<div id="titleSection" class="a-section a-spacing-none">
  <h1 id="title" class="a-size-medium a-spacing-none">
    <span id="productTitle" class="a-size-medium product-title-word-break">
      Apple AirPods Pro 2 Wireless Earbuds
    </span>
  </h1>
</div>
`;

const RATING_HTML = `
<div id="averageCustomerReviews_feature_div" class="celwidget">
  <span id="acrPopover" class="reviewCountTextLinkedHistogram noUnderline" title="4.6 out of 5 stars">
    <span class="a-declarative"><i class="a-icon a-icon-star"><span class="a-icon-alt">4.6 out of 5 stars</span></i></span>
  </span>
  <span id="acrCustomerReviewText" aria-label="46,747 Reviews" class="a-size-small">(46,747)</span>
</div>
`;

const BULLETS_HTML = `
<div id="featurebullets_feature_div" class="celwidget">
  <div id="feature-bullets" class="a-section a-spacing-medium">
    <h1 class="a-size-base-plus a-text-bold"> About this item </h1>
    <ul class="a-unordered-list a-vertical a-spacing-mini">
      <li class="a-spacing-mini"><span class="a-list-item"> Fitment one &amp; Nissan </span></li>
      <li class="a-spacing-mini"><span class="a-list-item"> Fitment two </span></li>
    </ul>
  </div>
</div>
`;

const GALLERY_HTML = `
<div id="imageBlock_feature_div">
  <script type="text/javascript">
    P.when('A').execute(function(A) {
      'colorImages': { 'initial': A.$.parseJSON('[{"hiRes":"https://m.media-amazon.com/images/I/61SUj2aKoEL._AC_SL1500_.jpg","large":"https://m.media-amazon.com/images/I/41aaaaaaa_L._AC_.jpg","main":{"https://m.media-amazon.com/images/I/61SUj2aKoEL._AC_SX679_.jpg":[679,679]}},{"hiRes":"https://m.media-amazon.com/images/I/611pEx7220L._AC_SL1500_.jpg","large":"https://m.media-amazon.com/images/I/41bbbbbbb_L._AC_.jpg"}]') },
      'colorToAsin': {'asin':'B0D1XD1ZV3'}
    });
  </script>
  <div id="altImages" class="a-fixed-left-grid-col a-col-left">
    <ul aria-label="Image thumbnails" class="a-unordered-list a-nostyle a-button-list">
      <li class="a-spacing-small item itemNo0 imageThumbnail variant-MAIN">
        <img src="https://m.media-amazon.com/images/I/41aaaaaaa_L._AC_US40_.jpg">
      </li>
      <li class="a-spacing-small item itemNo1 imageThumbnail variant-PT01">
        <img src="https://m.media-amazon.com/images/I/41bbbbbbb_L._AC_US40_.jpg">
      </li>
      <li class="a-spacing-small item itemNo6 videoThumbnail videoBlockIngress">
        <img src="https://m.media-amazon.com/images/I/41ccccccc_L._SS40_BG85,85,85_BR-120_PKdp-play-icon-overlay__.jpg">
      </li>
    </ul>
  </div>
</div>
`;

const GALLERY_THUMBNAILS_ONLY_HTML = `
<div id="altImages" class="a-fixed-left-grid-col a-col-left">
  <ul aria-label="Image thumbnails" class="a-unordered-list a-nostyle a-button-list">
    <li class="a-spacing-small item itemNo0 imageThumbnail variant-MAIN">
      <img src="https://m.media-amazon.com/images/I/41aaaaaaa_L._AC_US40_.jpg">
    </li>
    <li class="a-spacing-small item itemNo1 imageThumbnail variant-PT01">
      <img src="https://m.media-amazon.com/images/I/41bbbbbbb_L._AC_US40_.jpg">
    </li>
  </ul>
</div>
`;

const APLUS_HTML = `
<div id="aplus_feature_div" class="celwidget">
  <div class="aplus-module">
    <img alt="lazy" class="a-lazy-loaded"
      src="https://images-na.ssl-images-amazon.com/images/G/01/x-locale/common/grey-pixel.gif"
      data-src="https://m.media-amazon.com/images/S/aplus-media-library-service-media/037f78de.__CR0,0,1464,600_PT0_SX1464_V1___.jpg">
    <img alt="second"
      src="https://m.media-amazon.com/images/S/aplus-media-library-service-media/70b36d7a.__CR0,0,1464,600_PT0_SX1464_V1___.jpg">
  </div>
</div>
`;

const DESCRIPTION_HTML = `
<div id="productDescription_feature_div">
  <div id="productDescription" class="a-section a-spacing-small">
    <p><span>Some description</span></p>
    <img src="https://m.media-amazon.com/images/I/51MaYOvFSTL._AC_SL1200_.jpg">
    <img src="https://m.media-amazon.com/images/I/51EOeqiBTCL._AC_SL1200_.jpg">
  </div>
</div>
`;

test("extractSellerName prefers the merchant trust card over the link label", () => {
  assert.equal(extractSellerName(MERCHANT_TRUST_CARD_HTML), "Marsram");
});

test("extractSellerName rejects a placeholder link label", () => {
  assert.equal(extractSellerName(SELLER_PLACEHOLDER_ONLY_HTML), "");
});

test("extractSellerName still reads the trigger when it holds the name", () => {
  assert.equal(extractSellerName(ODF_MERCHANT_SPAN_HTML), "Marsram");
});

test("a listing without a Buy Box still yields every other field", () => {
  const checks = {
    title: true,
    rating: true,
    bulletPoints: true,
    imageA: true,
    category: true,
    addToCart: true,
    seller: true
  };

  const extracted = extractAmazonListingChecks(NO_BUY_BOX_HTML, checks);

  assert.equal(extracted.title, "ENA Ignition Coil 84005272");
  assert.equal(extracted.ratingValue, "4.6");
  assert.equal(extracted.ratingCount, "9");
  assert.deepEqual(extracted.bulletPoints, ["Fitment one"]);
  assert.equal(extracted.categoryName, "Automotive");
  assert.equal(extracted.hasAddToCart, false);
  assert.equal(extracted.sellerName, "");
  assert.equal(
    extracted.imageAUrl,
    "https://m.media-amazon.com/images/I/41bbbbbbb_L._AC_SL1500_.jpg"
  );
});

test("extractCategoryName returns the top navigation category label", () => {
  assert.equal(extractCategoryName(SAMPLE_HTML), "Automotive");
});

test("extractCategoryName supports All Beauty top nav layout", () => {
  assert.equal(extractCategoryName(AMAZON_SOLD_BY_HTML), "All Beauty");
});

// The store tab is the anchor in the page's own subnav bar, which is what the
// popup calls the "大类" (department). Real structure captured from live pages.
const SUBNAV_AUTOMOTIVE = `
<div id="nav-subnav" data-category="automotive">
  <a href="/automotive-auto-truck-replacements-parts/b/?node=15684181" class="nav-a nav-b" aria-label="Automotive" tabindex="0">
    <span class="nav-a-content"> Automotive </span>
  </a>
  <a href="/Vehicles/b/?node=10677469011" class="nav-a" aria-label="Amazon Autos" tabindex="0">
    <span class="nav-a-content"> Amazon Autos </span>
  </a>
</div>`;

const SUBNAV_APPLE = `
<div id="nav-subnav" data-category="apple-devices">
  <a href="/apple/b/?node=16735455011" class="nav-a nav-b" aria-label="Apple Products" tabindex="0">
    <span class="nav-a-content"> Apple Products </span>
  </a>
  <a href="/iPad/b/?node=1" class="nav-a" aria-label="iPad" tabindex="0">
    <span class="nav-a-content"> iPad </span>
  </a>
</div>`;

test("extractCategoryName reads the department store tab from the subnav bar", () => {
  assert.equal(extractCategoryName(SUBNAV_AUTOMOTIVE), "Automotive");
  assert.equal(extractCategoryName(SUBNAV_APPLE), "Apple Products");
});

// A page dump carries many nav anchors; the answer must come from the subnav,
// not from whichever .nav-a.nav-b happens to appear first in the markup.
test("extractCategoryName prefers the subnav over an earlier decoy anchor", () => {
  const decoy = `<a class="nav-a nav-b" aria-label="Books"><span class="nav-a-content">Books</span></a>`;
  assert.equal(extractCategoryName(decoy + SUBNAV_APPLE), "Apple Products");
});

// Books and other digital listings render no department subnav at all, so the
// field is legitimately blank rather than filled with a neighboring department.
test("extractCategoryName returns empty when the listing has no department subnav", () => {
  const bookPage = `
    <div id="nav-subnav-placeholder"></div>
    <a class="nav-a" aria-label="Books"><span class="nav-a-content">Books</span></a>
    <div id="wayfinding-breadcrumbs_feature_div">
      <a href="/Books/b/?node=283155">Books</a>
    </div>`;

  assert.equal(extractCategoryName(bookPage), "");
});

test("extractCategoryName falls back to the store tab label when aria-label is absent", () => {
  const noAria = `
    <div id="nav-subnav" data-category="automotive">
      <a href="/automotive/b/?node=15684181" class="nav-a nav-b" tabindex="0">
        <span class="nav-a-content"> Automotive </span>
      </a>
    </div>`;

  assert.equal(extractCategoryName(noAria), "Automotive");
});

test("extractCategoryName returns empty for a page without any store tab", () => {
  assert.equal(extractCategoryName("<html><body>nothing here</body></html>"), "");
});

test("hasAddToCartButton returns true when the add to cart button exists", () => {
  assert.equal(hasAddToCartButton(SAMPLE_HTML), true);
});

test("extractSellerName returns the buy box seller text", () => {
  assert.equal(extractSellerName(SAMPLE_HTML), "U.S. Based seller");
});

test("extractSellerName supports shipFromSoldBy abbreviated buy box layout", () => {
  assert.equal(extractSellerName(AMAZON_SOLD_BY_HTML), "Amazon.com");
});

test("extractProductTitle reads the product title", () => {
  assert.equal(
    extractProductTitle(TITLE_AND_HIGHLIGHT_HTML),
    "Marsram Ignition Coil Pack UF596 Spark Plug for 2009-2017 Toyota Corolla L4"
  );
});

test("extractTitleHighlight reads the subtitle beneath the title", () => {
  assert.equal(
    extractTitleHighlight(TITLE_AND_HIGHLIGHT_HTML),
    "Double Iridium Spark Plug 4912 Fit for 2010-2015 Toyota Prius Matrix"
  );
});

test("extractTitleHighlight returns empty when the listing has no highlight", () => {
  assert.equal(extractTitleHighlight(TITLE_WITHOUT_HIGHLIGHT_HTML), "");
  assert.equal(extractProductTitle(TITLE_WITHOUT_HIGHLIGHT_HTML), "Apple AirPods Pro 2 Wireless Earbuds");
});

test("extractRatingValue and extractRatingCount read the review summary", () => {
  assert.equal(extractRatingValue(RATING_HTML), "4.6");
  assert.equal(extractRatingCount(RATING_HTML), "46747");
});

test("rating helpers return empty for listings without reviews", () => {
  assert.equal(extractRatingValue(SAMPLE_HTML), "");
  assert.equal(extractRatingCount(SAMPLE_HTML), "");
});

test("extractBulletPoints collects every About this item bullet", () => {
  assert.deepEqual(extractBulletPoints(BULLETS_HTML), ["Fitment one & Nissan", "Fitment two"]);
});

test("extractBulletPoints returns an empty list when the block is absent", () => {
  assert.deepEqual(extractBulletPoints(SAMPLE_HTML), []);
});

test("extractGalleryImages prefers hi-res colorImages and skips videos", () => {
  assert.deepEqual(extractGalleryImages(GALLERY_HTML), [
    "https://m.media-amazon.com/images/I/61SUj2aKoEL._AC_SL1500_.jpg",
    "https://m.media-amazon.com/images/I/611pEx7220L._AC_SL1500_.jpg"
  ]);
});

test("extractGalleryImages falls back to thumbnails when colorImages is missing", () => {
  assert.deepEqual(extractGalleryImages(GALLERY_THUMBNAILS_ONLY_HTML), [
    "https://m.media-amazon.com/images/I/41aaaaaaa_L._AC_SL1500_.jpg",
    "https://m.media-amazon.com/images/I/41bbbbbbb_L._AC_SL1500_.jpg"
  ]);
});

test("extractDetailImages prefers description images", () => {
  assert.deepEqual(extractDetailImages(DESCRIPTION_HTML), [
    "https://m.media-amazon.com/images/I/51MaYOvFSTL._AC_SL1200_.jpg",
    "https://m.media-amazon.com/images/I/51EOeqiBTCL._AC_SL1200_.jpg"
  ]);
});

test("extractDetailImages falls back to A+ images and drops lazy placeholders", () => {
  assert.deepEqual(extractDetailImages(APLUS_HTML), [
    "https://m.media-amazon.com/images/S/aplus-media-library-service-media/037f78de.__CR0,0,1464,600_PT0_SX1464_V1___.jpg",
    "https://m.media-amazon.com/images/S/aplus-media-library-service-media/70b36d7a.__CR0,0,1464,600_PT0_SX1464_V1___.jpg"
  ]);
});

test("detectAmazonRobotCheck recognizes common anti-bot content", () => {
  assert.equal(detectAmazonRobotCheck("<title>Robot Check</title>"), true);
  assert.equal(detectAmazonRobotCheck(SAMPLE_HTML), false);
});

test("detectContinueShoppingGate recognizes the interstitial form", () => {
  assert.equal(
    detectContinueShoppingGate("<h4>Click the button below to continue shopping</h4>"),
    true
  );
  assert.equal(detectContinueShoppingGate(SAMPLE_HTML), false);
});

test("detectNoFeaturedOffers recognizes pages without a buy box offer", () => {
  assert.equal(detectNoFeaturedOffers("No featured offers available Learn more"), true);
  assert.equal(detectNoFeaturedOffers(SAMPLE_HTML), false);
});

test("extractAmazonListingChecks returns only the selected checks", () => {
  const html = [TITLE_AND_HIGHLIGHT_HTML, RATING_HTML, BULLETS_HTML, GALLERY_HTML, APLUS_HTML].join("");

  assert.deepEqual(
    extractAmazonListingChecks(html, {
      title: true,
      titleHighlight: true,
      rating: true,
      bulletPoints: true,
      imageA: true,
      imageDetail: true,
      category: false,
      addToCart: false,
      seller: false
    }),
    {
      categoryName: null,
      title: "Marsram Ignition Coil Pack UF596 Spark Plug for 2009-2017 Toyota Corolla L4",
      titleHighlight: "Double Iridium Spark Plug 4912 Fit for 2010-2015 Toyota Prius Matrix",
      ratingValue: "4.6",
      ratingCount: "46747",
      bulletPoints: ["Fitment one & Nissan", "Fitment two"],
      imageAUrl: "https://m.media-amazon.com/images/I/611pEx7220L._AC_SL1500_.jpg",
      imageDetailUrl: "https://m.media-amazon.com/images/S/aplus-media-library-service-media/037f78de.__CR0,0,1464,600_PT0_SX1464_V1___.jpg",
      hasAddToCart: null,
      sellerName: null,
      criticalReviews: null,
      stockStatus: null,
      deliveryPromise: null,
      fulfilmentRoute: null
    }
  );
});

test("extractAmazonListingChecks still serves the legacy checks", () => {
  assert.deepEqual(
    extractAmazonListingChecks(SAMPLE_HTML, {
      category: true,
      addToCart: true,
      seller: true
    }),
    {
      categoryName: "Automotive",
      title: null,
      titleHighlight: null,
      ratingValue: null,
      ratingCount: null,
      bulletPoints: null,
      imageAUrl: null,
      imageDetailUrl: null,
      hasAddToCart: true,
      sellerName: "U.S. Based seller",
      criticalReviews: null,
      stockStatus: null,
      deliveryPromise: null,
      fulfilmentRoute: null
    }
  );
});
