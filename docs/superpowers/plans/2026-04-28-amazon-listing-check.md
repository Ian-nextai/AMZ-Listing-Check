# Amazon Listing Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Manifest V3 browser extension that accepts ASINs, runs selected Amazon listing checks on a dedicated worker tab, and exports actual results to XLSX.

**Architecture:** Reuse the reference extension's `popup + background worker + hidden worker tab` pattern. Keep Amazon parsing and export shaping in testable pure modules, then let the background worker orchestrate navigation, scraping, persistence, progress reporting, and XLSX download.

**Tech Stack:** Chrome Extension Manifest V3, vanilla HTML/CSS/JS modules, Node built-in test runner, SheetJS vendor bundle reused from the reference extension.

---

### Task 1: Create parser and export tests first

**Files:**
- Create: `tests/amazon-parser.test.mjs`
- Create: `tests/export-plan.test.mjs`

- [ ] **Step 1: Write failing parser tests**
- [ ] **Step 2: Run parser tests and verify failure**
- [ ] **Step 3: Write failing export tests**
- [ ] **Step 4: Run export tests and verify failure**

### Task 2: Implement reusable Amazon logic

**Files:**
- Create: `amazon-listing-check-extension/src/core/amazon-parser.js`
- Create: `amazon-listing-check-extension/src/core/export-plan.js`
- Create: `amazon-listing-check-extension/src/core/task-utils.js`
- Create: `amazon-listing-check-extension/src/core/binary.js`

- [ ] **Step 1: Implement parser helpers to extract category, add-to-cart presence, seller, and robot-check detection**
- [ ] **Step 2: Implement export-row shaping helpers with stable columns**
- [ ] **Step 3: Run focused tests until green**

### Task 3: Implement extension runtime

**Files:**
- Create: `amazon-listing-check-extension/manifest.json`
- Create: `amazon-listing-check-extension/popup.html`
- Create: `amazon-listing-check-extension/popup.js`
- Create: `amazon-listing-check-extension/background.js`
- Create: `amazon-listing-check-extension/runner.html`
- Create: `amazon-listing-check-extension/runner.js`
- Create: `amazon-listing-check-extension/icon16.png`
- Create: `amazon-listing-check-extension/vendor/xlsx.mjs`

- [ ] **Step 1: Build popup UI for ASIN input, checkboxes, task state, and XLSX export**
- [ ] **Step 2: Build background workflow for dedicated tab execution, scraping, storage, and downloads**
- [ ] **Step 3: Reuse vendor XLSX module and generate workbook bytes**

### Task 4: Verify with simulated integration flow

**Files:**
- Create: `tests/background-flow.test.mjs`

- [ ] **Step 1: Write a task-flow simulation test around result shaping and completion summary**
- [ ] **Step 2: Run the full test suite**
- [ ] **Step 3: Smoke-check extension file structure and manifest**

---

## v2 Extension: listing data collection with embedded images

Verified against live Amazon.com pages in a real Chrome instance (see "Live verification").

### Collected fields

| Column | Source on the page |
| --- | --- |
| Title | `#productTitle` |
| Highlight | `.dp-title-differentiators` (subtitle under the title; absent on many ASINs) |
| Rating | `#acrPopover[title]` → `4.5` |
| Rating Count | `#acrCustomerReviewText` → `3498` (digits only, separators stripped) |
| BP | `#feature-bullets` list items joined with newlines into one cell |
| A图 | 2nd entry of the `colorImages` gallery array, falling back to the 2nd non-video `#altImages` thumbnail |
| 详情图 | 1st image in `#productDescription`, else 1st A+ image (`#aplus_feature_div`, `#aplusBrandStory_feature_div`) |

Every field has its own checkbox, all default to checked, and only checked columns are
written to the sheet. Highlight, rating, BP and images are optional on real listings, so a
miss leaves the cell blank and logs a note rather than failing the whole ASIN row.

### Image embedding

SheetJS 0.18.5 community **silently drops** worksheet `!images` (Pro-only feature), so
`src/core/xlsx-image.js` injects the OOXML drawing parts into the generated archive by
hand: `xl/media/imageN.<ext>`, `xl/drawings/drawing1.xml`, the drawing rels, the sheet rels,
the `<drawing>` reference and the `[Content_Types].xml` overrides. Anchors are
`oneCellAnchor` with a 120x120 px extent (9525 EMU per pixel).

Images are cached in memory only; `chrome.storage.local` persists URLs alone so a large
batch cannot exhaust the storage quota, and an export re-downloads anything the cache lost.

### Critical reviews (差评收集)

Opt-in checkbox, **unchecked by default** (all other checks stay checked). When on:

1. The detail page is scrolled to the bottom and any collapsed review bodies expanded;
   whatever critical reviews it already shows are kept.
2. If that is fewer than 30, the worker tab visits the reviews page, reached by splicing
   the ASIN into the URL rather than clicking through the page:

```
https://www.amazon.com/portal/customer-reviews/{ASIN}/ref=cm_cr_getr_d_show_all
    ?reviewerType=all_reviews&filterByStar=critical#reviews-filter-bar
```

3. On that page `a[data-hook="show-more-button"]` ("Show 10 more reviews") is clicked
   repeatedly — 10 reviews per click — until 30 are collected or the page stops growing.
4. Reviews with a star rating of 3 or lower are kept. A listing with fewer than 30
   critical reviews (or none) simply yields fewer entries; it never fails the row.
5. Every review goes into a single cell, numbered, in order:

```
#1 1星 Bad choice for OEM coils. Don't last
Johnny · Reviewed in the United States on September 22, 2025
Cheap replacement for original coils. Only lasted 4 months ...

#2 2星 ...
```

**The reviews page requires a signed-in Amazon session.** Logged out, both this URL and
the detail page's own "See more reviews" link redirect to `/ap/signin`. The collector
detects that redirect and falls back to the detail page's inline reviews, logging a note.

The detail page medley and the all-reviews page use **different markup**; the parser
handles both:

| Field | Detail page | All-reviews page |
| --- | --- | --- |
| Title | `[data-hook="reviewTitle"]` in `<h5>` | `[data-hook="review-title"]`, last non-empty `<span>` in the anchor |
| Body | `[data-hook="reviewRichContentContainer"]` | `[data-hook="review-body"]` |

### Live verification (critical reviews)

Verified against the live reviews page for B07FZ8S74R while signed in, using the
extension's own `extractCriticalReviews` module:

- 191 critical reviews available for the ASIN; **30 collected** (1★×9, 2★×6, 3★×15)
- Every review parsed with a non-empty title, body, author and date
- One cell, sequentially numbered `#1` … `#30`

This was run through **camofox-browser** (Camoufox, a Firefox fork with C++-level
fingerprint spoofing) because it reaches Amazon without the bot check that plain Chrome
hit. Camoufox cannot load a Chrome MV3 extension, so the run exercised the extension's
parser and collection logic over the REST API against real pages.



- Amazon's "Click the button below to continue shopping" gate is cleared automatically,
  then the requested URL is reloaded.
- A failure in the zip-code step degrades to a warning instead of discarding the scrape.
- Fields that a listing simply does not have (Highlight, reviews, BP, images, Buy Box
  seller) leave the cell blank and log a note; they never fail the row. Only a missing
  category or title fails an ASIN.
- `--disable-extensions-except` is ignored by Chrome 153, and `--load-extension` no longer
  loads unpacked extensions; use CDP `Extensions.loadUnpacked` with a `C:/...` path.

### Delivery zip code

The location popover hides `#GLUXZipUpdateInput` behind a country dropdown whose option
list omits plain "United States" on a fresh session, so driving the popover leaves the
input invisible and its computed click point at (0,0). The zip is therefore set by calling
the same endpoint the popover uses:

```
POST /gp/delivery/ajax/address-change.html
locationType=LOCATION_INPUT&zipCode=<zip>&storeContext=generic&deviceType=web&pageType=Gateway&actionSource=glow
```

A valid response returns `isValidAddress: 1` and the resolved address; the tab is then
reloaded and `#glow-ingress-line2` is verified to contain the zip. This is what makes the
Buy Box render, which in turn is what populates the seller and add-to-cart columns.

### Live verification

Driven through the real extension UI in Chrome against live product pages, with the zip
endpoint fix in place:

| ASIN | Seller | Add To Cart | Notes |
| --- | --- | --- | --- |
| B07FZ8S74R | Marsram | true | highlight + 6 BP + both images |
| B09B8V1LZ3 | U.S. Based seller | true | no highlight on this listing |
| B0D1XD1ZV3 | (blank) | false | no Buy Box on this listing; every other field present |

Export: 3 rows, 6 embedded JPEGs anchored at columns I and J.
