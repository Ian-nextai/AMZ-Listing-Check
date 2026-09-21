# Implementation Plan: Stock and Delivery Status Collection

**Branch**: `001-stock-delivery-status` | **Date**: 2026-09-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-stock-delivery-status/spec.md`

## Summary

Add four optional, default-off columns — stock status, delivery promise, fulfilment route,
and Prime eligibility — extracted from the listing page's availability and Buy Box regions.
The work is additive: a new pure extractor in `src/core/amazon-parser.js`, four new keys
threaded through the existing checkbox → task-state → export-plan chain, and no change to
any existing column.

## Technical Context

**Language/Version**: JavaScript (ES modules), no transpilation

**Primary Dependencies**: none added; existing vendored SheetJS and fflate unchanged

**Storage**: `chrome.storage.local` — the four values ride along inside the existing
per-ASIN result record; no new storage keys

**Testing**: `node --test tests/*.test.mjs`, fixtures built from captured real markup

**Target Platform**: Chrome MV3 extension, `www.amazon.com`

**Project Type**: browser extension (no build step)

**Performance Goals**: no measurable change to per-ASIN runtime; extraction is four extra
DOM reads on a page already being read

**Constraints**: extraction must stay pure and chrome-free (constitution Principle I);
absent values must not fail a row (Principle III); the exported workbook must be opened and
checked (Principle V)

**Scale/Scope**: four new columns, one new extractor, ~6 files touched

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
| --- | --- | --- |
| I. Pure Core, Thin Chrome Shell | Extraction logic goes in `src/core/amazon-parser.js` as a pure `(html) => fields` function; `background.js` only orchestrates | PASS — planned |
| II. Test-First for Parsing and Export | Tests written against captured real markup before the extractor changes | PASS — planned, fixtures must come from the two probed listings |
| III. Absent Data Is Not an Error | All four fields route through `collectMissingFieldNotes`, never `validateExtractedChecks` | PASS — planned |
| IV. Zero Build, Vendored Dependencies | No new dependency, no build step | PASS |
| V. Verify the Artifact, Not the Source | Acceptance requires opening the produced XLSX for a stocked and an unavailable listing | PASS — planned |

No violations. No complexity-tracking exceptions needed.

## Project Structure

### Documentation (this feature)

```text
specs/001-stock-delivery-status/
├── spec.md              # Feature specification
├── plan.md              # This file
└── tasks.md             # Phase 2 output
```

### Source Code (repository root)

```text
amazon-listing-check-extension/
├── popup.html                     # +4 checkboxes
├── popup.js                       # +4 entries in CHECKBOX_IDS, default-off handling
├── background.js                  # +4 missing-field notes; no new orchestration
└── src/core/
    ├── amazon-parser.js           # + extractStockStatus / extractDeliveryPromise /
    │                              #   extractFulfilmentRoute / detectPrime
    │                              # + wired into extractAmazonListingChecks
    ├── export-plan.js             # +4 columns
    └── task-state.js              # +4 CHECK_KEYS, +4 stored fields

tests/
├── stock-delivery.test.mjs        # NEW — extraction against captured markup
└── export-plan.test.mjs           # updated column expectations
```

## Phase 0: Research

**Findings from live probing** (two listings, signed-in session, US zip 10010):

| Question | Finding |
| --- | --- |
| Where is stock text? | `#availability` — but on an unavailable listing the same node contains a `<script>` block, so script content must be rejected |
| Where is the delivery promise? | `#mir-layout-DELIVERY_BLOCK` / `#deliveryBlockMessage`; absent on unavailable listings |
| Where is fulfilment route? | `#fulfilmentInfoFeature_feature_div` (ships from) and `#merchantInfoFeature_feature_div` (sold by) in the Buy Box |
| How to detect Prime? | Prime badge presence; absence is a definitive "not Prime" |
| Is static HTML enough? | No — the delivery block is partly client-rendered, so extraction runs on the settled DOM the collector already captures |

**Decision**: reject script text by checking for `P.when(` / `function(` markers before
accepting an availability string. This is the one non-obvious rule; everything else is a
straight text read with the existing `normalizeText`/`stripTags` helpers.

**Alternatives considered**: parsing the delivery promise into a structured date range —
rejected. The wording varies (`FREE delivery Saturday, September 26`, `Or Prime members get
FREE …`), and normalising it would discard the information buyers actually see.

## Phase 1: Design

**Data model** (four fields on the existing per-ASIN result record):

- `stockStatus`: string, verbatim page wording, `""` when absent
- `deliveryPromise`: string, whitespace-collapsed, `""` when absent
- `fulfilmentRoute`: string, e.g. `Ships from Amazon / Sold by Marsram`, `""` when absent
- `isPrime`: boolean or `null` — `null` only when the page never settled the Buy Box

**Contracts**: `extractAmazonListingChecks(html, selectedChecks)` gains four keys that are
`null` when the corresponding checkbox is off (matching how the existing optional fields
behave), and real values / `""` when it is on.

**Quickstart**: run one stocked and one unavailable ASIN with only the new boxes ticked;
confirm the stock cell distinguishes them and the unavailable row still succeeds.

## Phase 2: Task Breakdown

Ordered so each step is independently verifiable:

1. **Capture fixtures** — save the settled DOM of one stocked and one unavailable listing.
2. **Write failing tests** — extraction tests against those fixtures, including the
   script-rejection case and the absent-field cases.
3. **Implement the extractor** — the four functions in `amazon-parser.js`, wired into
   `extractAmazonListingChecks`.
4. **Thread through state and export** — `CHECK_KEYS`, `recordTaskSuccess`/`Failure`,
   `EXPORT_COLUMNS`, and the default-off rule in `popup.js` + `popup.html`.
5. **Add missing-field notes** — extend `collectMissingFieldNotes` so each absent value is
   logged without failing the row.
6. **Verify the artifact** — drive the extension against the two listings and open the
   exported XLSX.

## Risks

- **Delivery wording drift**: Amazon varies the promise text by locale and fulfilment
  type. Mitigated by exporting verbatim rather than parsing.
- **Client-rendered delivery block**: if the promise never renders, the cell is blank —
  which the spec explicitly accepts rather than treating as failure.
- **Column explosion**: four more columns widen the sheet. Acceptable because every one is
  opt-in and absent columns are excluded entirely.
