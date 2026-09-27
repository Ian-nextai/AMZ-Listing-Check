# AMZ-Listing-Check

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
| Category | department store tab in `#nav-subnav` (blank for books and other digital listings, which render none) |
| Add To Cart | presence of `#add-to-cart-button` |
| Seller | Buy Box merchant name |
| 库存状态 / 配送时效 / 配送方式 | `#availability`, `#mir-layout-DELIVERY_BLOCK`, offer feature slots |

Fields a listing simply does not have (no reviews, no Buy Box, no A+ content, no
department tab) leave the cell blank and log a note — they never fail the row. Only a
missing title fails one.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the `assets/extension` folder.

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
assets/extension/
├── background.js              # service worker: task loop, navigation, scraping, export
├── popup.html / popup.js      # input, checkboxes, progress, controls
├── runner.html / runner.js    # monitoring page (survives popup close)
├── offscreen.html / .js       # keepalive + blob URL minting for large downloads
├── src/core/
│   ├── amazon-parser.js       # DOM extraction (pure, no chrome APIs)
│   ├── export-plan.js         # column layout and row/cell shaping
│   ├── task-state.js          # task record shape and transitions
│   ├── review-dedupe.js       # collapse the same review scraped from two pages
│   ├── image-cache.js         # bounded FIFO cache for fetched images (memory cap)
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
- **Image thumbnails.** The images render in a 120x120 cell but Amazon serves full
  gallery images (commonly 1500px on the long edge, several hundred KB each), which
  would otherwise dominate the workbook. `image-fetch.js` downscales every fetched
  image to fit a 256px box with `createImageBitmap` + `OffscreenCanvas` before caching
  it, preserving the aspect ratio and flattening transparency onto white. A two-ASIN
  export drops from 1.62 MB to 58 KB. Images already smaller than the box are left
  untouched, and if either canvas API is missing the original bytes are used as-is.
  The **图片尺寸** popup setting controls the long edge — 128 / 256 / 512 / 1024 px, or
  **原始尺寸** to keep Amazon's file. Headless runs pass `--max-image-edge N` (0 means
  no downscaling); when omitted the extension uses whatever the popup last saved.
- **Bounded image cache.** Fetched images are cached by URL so a re-export reuses them
  instead of re-downloading. At 1024px or 原始尺寸 each payload is hundreds of KB, so an
  unbounded cache is what actually kills a low-memory device on a 50-ASIN batch.
  `image-cache.js` caps it at 64 MB and evicts in insertion order (FIFO), never dropping
  the entry just written; failed downloads stay as zero-cost negative entries so exports
  don't retry them. The runner drains it between chunks via the `clear-image-cache`
  message (`--chunk N`); `get-status` reports the current bytes for the same purpose.
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

## Use as a Hermes skill (agent-ready)

This repo is laid out as a self-contained [Hermes Agent](https://hermes-agent.nousresearch.com/docs) skill —
clone it straight into your skills directory and the agent can drive the whole pipeline:

```bash
git clone git@github.com:Ian-nextai/AMZ-Listing-Check.git ~/.hermes/skills/devops/amazon-listing-check
```

`SKILL.md` at the repo root defines the agent workflow (pre-run confirmation, login gate
for reviews, artifact verification, delivery rules). Humans can still use the extension
standalone: load `assets/extension/` via `chrome://extensions` → Developer mode →
Load unpacked.

## Headless runner (server-side automation)

Run this extension in headless Chromium on a server — no manual browser clicking.
See **[docs/runner.md](docs/runner.md)** for the full pipeline:

```
./scripts/setup.sh                                   # env check & auto-install (Linux)
./scripts/run.sh "B0GY48WL28,B0GY49QL6C"             # one-shot: Chrome+CRX → xlsx
./scripts/run.sh "B0XXXXXXX" --with-reviews --feishu # login-gated reviews + delivery
```

On Windows use the native PowerShell entry point instead — it drives your installed
Microsoft Edge, so nothing has to be downloaded:

```powershell
.\scripts\run.ps1 "B0GY48WL28,B0GY49QL6C"
.\scripts\run.ps1 "B0XXXXXXX" -WithReviews -Chunk 8
```

It picks Edge first because **branded Google Chrome has refused `--load-extension`
since version 137** — it ignores the flag without failing, leaving the extension
silently unloaded. (Chromium, Edge, and Chrome for Testing all still allow it; see
[docs/runner.md](docs/runner.md#为什么不用-google-chrome).)

`--chunk N` splits the batch into groups of N, exporting each to its own workbook and
draining the extension's image cache between groups — use it when a large batch runs a
low-memory machine out of memory.

Runner includes a zero-dependency CDP driver (`drive.mjs`/`cdp.mjs`), Amazon login-state
detection (`check-login.mjs`), auto-retry for flaky ASINs, and an optional Feishu delivery
channel. Two extension tweaks are required for headless operation and already applied:
`TAB_LOAD_TIMEOUT_MS` 45000→150000 (huge listing pages exceed 45s on ARM) and a fixed
manifest `key` (stable extension ID for CDP targeting).
