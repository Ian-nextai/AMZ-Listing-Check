# AMZ-Check-CRX

Amazon Listing Check Helper — a Chrome MV3 extension that batch-checks Amazon.com
listings by ASIN and exports the collected data to XLSX.

## What it collects

Every column is optional and controlled by a checkbox in the popup:

| Column | Source |
| --- | --- |
| Title | `#productTitle` |
| Highlight | `.dp-title-differentiators` (subtitle under the title; absent on many ASINs) |
| Rating / Rating Count | `#acrPopover` and `#acrCustomerReviewText`, as two columns |
| BP | `#feature-bullets` items joined into one cell |
| 差评 (critical reviews) | reviews page filtered to 1–3 stars, up to 30, numbered in one cell |
| A图 | 2nd gallery image, embedded into the cell |
| 详情图 | 1st description / A+ image, embedded into the cell |
| Category | top navigation category label |
| Add To Cart | presence of `#add-to-cart-button` |
| Seller | Buy Box merchant name |

Fields a listing simply does not have (no reviews, no Buy Box, no A+ content) leave the
cell blank and log a note — they never fail the row.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the `amazon-listing-check-extension` folder.

## Usage

1. Sign in to Amazon.com in the same browser profile — the critical-reviews page
   requires a session.
2. Open the extension popup, paste ASINs (one per line), pick the fields you want.
3. Set the delivery zip code (a US zip is needed for the Buy Box to render, which is
   what populates the seller and add-to-cart columns).
4. Click **开始检查**. Progress appears in the popup and in the runner tab; results are
   exported to XLSX when the task finishes.

## Architecture

```
amazon-listing-check-extension/
├── background.js              # service worker: task loop, navigation, scraping, export
├── popup.html / popup.js      # input, checkboxes, progress, controls
├── runner.html / runner.js    # monitoring page (survives popup close)
├── offscreen.html / .js       # keepalive + blob URL minting for large downloads
├── src/core/
│   ├── amazon-parser.js       # DOM extraction (pure, no chrome APIs)
│   ├── export-plan.js         # column layout and row/cell shaping
│   ├── task-state.js          # task record shape and transitions
│   ├── review-dedupe.js       # collapse the same review scraped from two pages
│   ├── image-fetch.js         # download images as base64
│   ├── xlsx-image.js          # inject image parts into the generated XLSX
│   ├── task-utils.js          # ASIN / zip normalisation
│   ├── focus-policy.js        # when the worker tab may steal focus
│   └── binary.js
└── vendor/                    # SheetJS and fflate (bundled)
```

The parsing and export modules are pure functions so they can be tested directly under
Node. `tests/` covers them plus the background task lifecycle (start / discard / restart /
pause) against a fake `chrome` API.

## Notable implementation details

- **Image embedding.** SheetJS 0.18.5 community silently ignores worksheet `!images`, so
  `xlsx-image.js` injects the OOXML drawing parts (`xl/media/*`, `xl/drawings/*`, rels and
  content-type overrides) into the generated archive by hand.
- **Critical reviews.** Reached by splicing the ASIN into
  `/portal/customer-reviews/{ASIN}/...&filterByStar=critical`, then clicking
  `a[data-hook="show-more-button"]` until 30 reviews are collected. The detail page and
  the reviews page use different markup; both are handled. The reviews page is the
  authoritative source — the detail page truncates review bodies, so merging the two
  would list the same review twice.
- **Task lifecycle.** A run generation counter plus cancelled-token set keep an abandoned
  run from writing back over the task that replaced it.

## Tests

```bash
node --test tests/*.test.mjs
```
