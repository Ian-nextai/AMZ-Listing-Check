# 🛠 AMZ-Listing-Check

#### Batch-check Amazon listings by ASIN and export everything to Excel with images

Chrome Extension · Headless Pipeline · XLSX Export
License: MIT

Give it a list of ASINs. It opens each Amazon product page, collects title, price, coupon, discount, rating, stock, delivery, main/A+ images, critical reviews and Fitment Bar — then exports one Excel workbook with the images embedded.

Runs headless on a server (one `run.sh` command) or as a normal Chrome extension you click through.

---

## ✨ What it collects

Every column is optional (checkboxes in the popup):

| Column | Source |
| --- | --- |
| Title | `#productTitle` |
| Highlight | subtitle under the title; absent on many ASINs |
| Rating / Rating Count | `#acrPopover`, `#acrCustomerReviewText` |
| Price | buy-box price actually paid (never the struck-through reference) |
| Coupon | coupon badge, claim tile, brand promotion code |
| Discount | savings badge with reference price, e.g. `-9% (Typical price: $54.99)` |
| BP | `#feature-bullets`, joined into one cell |
| Critical reviews | reviews page filtered to 1–3 stars, up to 30, numbered (**requires login**) |
| Main image / Detail image | 2nd gallery image and first A+ image, embedded into the cell |
| Fitment Bar | whether the Amazon Confirmed Fit block exists (outputs `有` / `无`) |
| Category | department entry in `#nav-subnav` |
| Add To Cart / Seller / Stock / Delivery | Buy Box and delivery blocks |

A field the listing simply does not have (no reviews, no Buy Box, no A+ content) is left blank with a note — it never fails the row. Only a missing title fails one.

---

## 🚀 Two ways to use it

### 1) Headless (recommended for batches)

```bash
git clone https://github.com/Ian-nextai/AMZ-Listing-Check.git
cd AMZ-Listing-Check
scripts/setup.sh --check          # environment check

# basic run
scripts/run.sh "B0XXXXXXX,B0YYYYYYY" --zip 10010

# all fields incl. critical reviews (needs an Amazon session)
scripts/run.sh "B0XXXXXXX" --with-reviews

# large batch, chunked (drains the image cache between chunks)
scripts/run.sh "B0XX,B0YY,..." --chunk 8 --retry 1
```

Output lands in `~/Downloads/amazon-listing-check-<timestamp>.xlsx`; machine-readable results in `amz-last-run.json`.

Exit codes: `0` at least one success · `1` pipeline error · `2` all failed · `3` reviews requested but not signed in.

On Windows use the native PowerShell entry point — it drives your installed Edge, so nothing has to be downloaded:

```powershell
.\scripts\run.ps1 "B0XXXXXXX,B0YYYYYYY"
```

### 2) As a regular extension

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → pick the `assets/extension` folder.
Paste ASINs, tick the fields, set a zip code, hit start.

---

## ⚙️ Common flags

| Flag | Meaning |
| --- | --- |
| `--zip 10010` | delivery zip (Buy Box needs a US zip to render) |
| `--with-reviews` | collect critical reviews (**off by default**, login required) |
| `--chunk 8` | N per batch, drains image cache between batches |
| `--retry 1` | auto-rerun failed ASINs |
| `--check-login` | only check login state |
| `--no-images` | skip image columns |

Critical reviews are **off by default**: they cost ~40% more time and need a session.

### Path overrides (environment variables)

All writable paths default to `$HOME`, so **non-root users work out of the box**. Override with env vars to pin them elsewhere:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AMZ_PROFILE` | `$HOME/.hermes/amazon-profile` | Chrome persistent profile (session, zip) |
| `AMZ_DOWNLOADS` | `$HOME/Downloads` | where the xlsx files land |
| `AMZ_PORT` | `19222` | CDP debugging port |
| `CHROME` | auto-detected Playwright Chromium | browser executable |

`scripts/setup.sh --check` verifies both directories are writable, so permission problems surface early.

---

## 🔑 About signing in

Almost everything works without a session. Only **critical reviews** need one — Amazon's reviews page sits behind a login wall.

```bash
scripts/run.sh <ASIN> --check-login     # check whether loggedIn is true
scripts/run.sh --login                  # print the headless login guide
```

To sign in on a headless box: xvfb + x11vnc + noVNC + a temporary tunnel, log in yourself in the browser, then quit Chrome normally so cookies are flushed. See `docs/runner.md`.

> ⚠️ Once signed in, every scrape runs as that account. There is a theoretical risk of Amazon flagging the account — decide for yourself.

---

## 🧠 Implementation notes

- **Image embedding.** SheetJS community ignores worksheet `!images`, so `xlsx-image.js` injects the OOXML drawing parts (`xl/media/*`, `xl/drawings/*`, rels, content-type overrides) by hand.
- **Image thumbnails.** Amazon serves ~1500px originals; each is downscaled to a 256px box at fetch time before caching (a two-ASIN export drops from 1.62 MB to 58 KB).
- **Bounded image cache.** Cached by URL, capped at 64 MB, FIFO eviction; `--chunk N` drains it between batches. **Failures are never cached** — otherwise one network blip poisons a shared image URL for every later ASIN.
- **Parsing is pure.** Everything under `src/core/` touches no chrome API, so it is unit-testable under Node.
- **Stable extension ID.** A fixed `key` in the manifest keeps the extension ID constant for CDP targeting.

`tests/` covers parsing and export, plus the background task lifecycle (start / discard / restart / pause):

```bash
node --test tests/*.test.mjs
```

---

## 📁 Layout

```
assets/extension/         the extension (loadable as-is)
  background.js           service worker: task loop, navigation, scraping, export
  popup.html / popup.js   input, checkboxes, progress
  runner.html / runner.js monitoring page (survives popup close)
  src/core/               pure functions: parsing, export layout, images, task state
scripts/                  one-shot runner stack (zero npm dependencies)
  run.sh / run.ps1        entry points
  drive.mjs / cdp.mjs     hand-rolled CDP driver (no deps)
  setup.sh                environment check
docs/runner.md            headless operation and login walkthrough
```

---

## 🤝 About

I'm Ian. This is tooling I built for my own work and only open-sourced after it ran in production.
If it helps you, a ⭐ is enough. Issues and Discussions are open for questions and suggestions.

---

MIT License · free to use / modify / redistribute

Made by @Ian-nextai
