---
description: "Task list for stock and delivery status collection"
---

# Tasks: Stock and Delivery Status Collection

**Input**: Design documents from `/specs/001-stock-delivery-status/`

**Prerequisites**: plan.md, spec.md, `.specify/memory/constitution.md`

**Tests**: REQUIRED. Constitution Principle II mandates test-first for any `src/core/`
change, with fixtures built from real captured markup. Tests are not optional here.

**Organization**: Tasks are grouped by user story so each is independently implementable
and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Exact file paths are included in every task

## Path Conventions

This is a single-project browser extension, no build step:

- Extension source: `amazon-listing-check-extension/`
- Pure logic: `amazon-listing-check-extension/src/core/`
- Tests: `tests/`

## Verified Facts (from live probing — do not re-derive)

Probed against a signed-in session, US zip 10010. These drive the implementation:

| Signal | Selector | In-stock (B0CKWX6W1L) | Unavailable (B0FK27RC39) |
| --- | --- | --- | --- |
| Stock | `#availability` | `In Stock` **and contains a `<script>`** | node present but script-only |
| Delivery | `#mir-layout-DELIVERY_BLOCK` | `FREE delivery Saturday, September 26 …` | absent |
| Ships from | `[offer-display-feature-name="desktop-fulfiller-info"]` | present | absent |
| Sold by | `[offer-display-feature-name="desktop-merchant-info"]` | present | absent |
| Prime | `i.a-icon-prime` / `.prime-logo` | present | absent |

**The script-rejection rule (FR-005) is the one non-obvious requirement**: on an
unavailable listing `#availability` holds a `<script>` block, so raw `textContent` would
export JavaScript source as the stock value.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Fixtures and test scaffold that every story depends on

- [ ] T001 Capture two settled-DOM fixtures and save them as `tests/fixtures/stock-in-stock.html` (from B0CKWX6W1L) and `tests/fixtures/stock-unavailable.html` (from B0FK27RC39), preserving the raw HTML including the `<script>` inside `#availability`
- [ ] T002 Create `tests/stock-delivery.test.mjs` with a fixture loader that reads both files from `tests/fixtures/` using `node:fs`, importing `node:test` and `node:assert/strict` to match the existing test files

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The state/export/plumbing chain every story writes into

**CRITICAL**: No user story work can begin until this phase is complete

- [ ] T003 Add `stockStatus`, `deliveryPromise`, `fulfilmentRoute`, `isPrime` to the `CHECK_KEYS` array in `amazon-listing-check-extension/src/core/task-state.js` so checkbox selections persist (FR-001)
- [ ] T004 Persist the four fields in `recordTaskSuccess` and blank them in `recordTaskFailure` in `amazon-listing-check-extension/src/core/task-state.js`, mirroring how `criticalReviews` is handled (array default stays out; these are string/boolean and default to `""` / `null`)
- [ ] T005 Extend `collectMissingFieldNotes` in `amazon-listing-check-extension/background.js` with a note per enabled-but-absent field (`无库存信息`, `无配送时效`, `无配送方式`, `无 Prime 标识`) so absences are logged and the row still succeeds (FR-009, constitution Principle III)

**Checkpoint**: The plumbing exists; user stories can now proceed independently

---

## Phase 3: User Story 1 - Stock level (Priority: P1) MVP

**Goal**: A run reports each listing's stock wording, so out-of-stock listings are
visible without opening every page.

**Independent Test**: Run one in-stock and one unavailable ASIN with only 库存状态 ticked;
the exported column distinguishes them and the unavailable row still succeeds.

### Tests for User Story 1

> Write first, confirm it FAILS, then implement

- [ ] T006 [P] [US1] Add failing tests to `tests/stock-delivery.test.mjs`: `extractStockStatus` returns `In Stock` for `stock-in-stock.html`
- [ ] T007 [P] [US1] Add failing test asserting `extractStockStatus` returns `""` for `stock-unavailable.html` and that the result contains none of `P.when(`, `function(`, `document.` — the FR-005 script-rejection rule

### Implementation for User Story 1

- [ ] T008 [US1] Implement and export `extractStockStatus(html)` in `amazon-listing-check-extension/src/core/amazon-parser.js`: read `#availability`, strip `<script>`/`<style>` before reading text, reject any result still containing script markers, normalise whitespace with the existing helper (FR-004, FR-005, FR-011)
- [ ] T009 [P] [US1] Add the `库存状态` column (`key: "stockStatus"`, `check: "stockStatus"`) to `EXPORT_COLUMNS` in `amazon-listing-check-extension/src/core/export-plan.js` (FR-003)
- [ ] T010 [US1] Add the `库存状态` checkbox (`id="check-stock-status"`, no `checked` attribute) to `amazon-listing-check-extension/popup.html` and register `stockStatus: "check-stock-status"` in `CHECKBOX_IDS` in `amazon-listing-check-extension/popup.js`
- [ ] T011 [US1] Add the `DEFAULT_OFF_CHECKS` set containing `"stockStatus"` to `amazon-listing-check-extension/popup.js` and make `hydrateSavedSettings` honour it, so the box stays unchecked on a fresh profile (FR-002)
- [ ] T012 [US1] Wire `stockStatus` into `extractAmazonListingChecks` in `amazon-listing-check-extension/src/core/amazon-parser.js`, returning `null` when the check is off and a string otherwise

**Checkpoint**: 库存状态 is fully functional and independently testable — this is the MVP

---

## Phase 4: User Story 2 - Delivery promise (Priority: P2)

**Goal**: A run reports the promised delivery window per ASIN.

**Independent Test**: An ASIN with a promise yields that text; an unavailable ASIN yields
a blank cell without failing.

### Tests for User Story 2

- [ ] T013 [P] [US2] Add failing tests to `tests/stock-delivery.test.mjs`: `extractDeliveryPromise` returns text containing `delivery` for `stock-in-stock.html`, and `""` for `stock-unavailable.html`

### Implementation for User Story 2

- [ ] T014 [US2] Implement and export `extractDeliveryPromise(html)` in `amazon-listing-check-extension/src/core/amazon-parser.js` reading `#mir-layout-DELIVERY_BLOCK`, stripping `<script>`/`<style>`, collapsing whitespace (FR-006, FR-011)
- [ ] T015 [P] [US2] Add the `配送时效` column (`key: "deliveryPromise"`, `check: "deliveryPromise"`) to `EXPORT_COLUMNS` in `amazon-listing-check-extension/src/core/export-plan.js`
- [ ] T016 [US2] Add the `配送时效` checkbox (`id="check-delivery-promise"`) to `amazon-listing-check-extension/popup.html`, register it in `CHECKBOX_IDS`, and add `"deliveryPromise"` to `DEFAULT_OFF_CHECKS` in `amazon-listing-check-extension/popup.js`
- [ ] T017 [US2] Wire `deliveryPromise` into `extractAmazonListingChecks` in `amazon-listing-check-extension/src/core/amazon-parser.js`

**Checkpoint**: US1 and US2 both work independently

---

## Phase 5: User Story 3 - Fulfilment route and Prime (Priority: P3)

**Goal**: A run distinguishes Amazon-fulfilled Prime listings from merchant-fulfilled ones.

**Independent Test**: A Prime listing populates both cells; a non-Prime listing reports a
definitive negative rather than blank or failure.

### Tests for User Story 3

- [ ] T018 [P] [US3] Add failing tests to `tests/stock-delivery.test.mjs`: `extractFulfilmentRoute` reports who ships and who sells for `stock-in-stock.html` and `""` for `stock-unavailable.html`
- [ ] T019 [P] [US3] Add failing tests to `tests/stock-delivery.test.mjs`: `detectPrime` returns `true` for `stock-in-stock.html` and `false` (not `null`, not `""`) for `stock-unavailable.html`, per FR-008 treating absence as a definitive negative

### Implementation for User Story 3

- [ ] T020 [US3] Implement and export `extractFulfilmentRoute(html)` in `amazon-listing-check-extension/src/core/amazon-parser.js` reading the `desktop-fulfiller-info` and `desktop-merchant-info` offer-display features (the same attribute pattern already used by `extractSellerName`), formatting as `Ships from X / Sold by Y` and omitting a missing half (FR-007)
- [ ] T021 [US3] Implement and export `detectPrime(html)` in `amazon-listing-check-extension/src/core/amazon-parser.js` returning a boolean from the Prime badge (`i.a-icon-prime` or `.prime-logo`) (FR-008)
- [ ] T022 [P] [US3] Add the `配送方式` (`fulfilmentRoute`) and `Prime` (`isPrime`) columns to `EXPORT_COLUMNS` in `amazon-listing-check-extension/src/core/export-plan.js`
- [ ] T023 [US3] Add the `配送方式` and `Prime` checkboxes (`id="check-fulfilment-route"`, `id="check-prime"`) to `amazon-listing-check-extension/popup.html`, register them in `CHECKBOX_IDS`, and add both keys to `DEFAULT_OFF_CHECKS` in `amazon-listing-check-extension/popup.js`
- [ ] T024 [US3] Wire `fulfilmentRoute` and `isPrime` into `extractAmazonListingChecks` in `amazon-listing-check-extension/src/core/amazon-parser.js`, and format `isPrime` for the cell as `true`/`false`/`""` the way `hasAddToCart` already does

**Checkpoint**: All three stories independently functional

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Constitution Principle V — verify the artifact, not the source

- [ ] T025 [P] Run `node --test tests/*.test.mjs` and confirm the whole suite is green with the new tests included
- [ ] T026 Verify SC-003: with all four boxes unchecked, confirm the exported column set is byte-identical to the pre-feature layout by asserting `getActiveColumns` output against the existing `export-plan.test.mjs` expectations
- [ ] T027 Verify the artifact: load `amazon-listing-check-extension/` in Chrome, run B0CKWX6W1L (in stock) and B0FK27RC39 (unavailable) with all four boxes ticked, then open the produced `.xlsx` from the downloads directory and confirm the stock cell distinguishes them, the Prime cell reads `true`/`false`, and the unavailable row still shows `success` in `amazon-listing-check-extension/background.js`'s export
- [ ] T028 Bump `version` in `amazon-listing-check-extension/manifest.json` and rebuild `amazon-listing-check-extension.zip`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — **BLOCKS all user stories**
- **User Stories (Phase 3+)**: All depend on Foundational; then independent of each other
- **Polish (Phase 6)**: Depends on all three stories

### User Story Dependencies

All three are independent after Phase 2. T012, T017 and T024 all edit
`extractAmazonListingChecks` in the same file, so they must be applied sequentially even
though the stories themselves are independent.

### Within Each User Story

Tests first (they must FAIL) → extractor → export column → checkbox → wiring.

### Parallel Opportunities

- T001, T002 in Setup are independent files
- T006, T007 (US1 tests) can be written together
- T009 (export column) can proceed while T008 (extractor) is written — different files
- Across stories: T013/T015, T018/T019/T022 are all different-file edits

---

## Implementation Strategy

### MVP First

1. Phase 1 → Phase 2 → Phase 3 (US1 only)
2. **STOP and VALIDATE**: in-stock vs unavailable distinguishes correctly
3. That alone delivers the reason the feature exists

### Incremental Delivery

1. Setup + Foundational → plumbing ready
2. US1 → 库存状态 works → validate → MVP
3. US2 → 配送时效 added → validate
4. US3 → 配送方式 + Prime added → validate
5. Each addition leaves the previous stories working

---

## Notes

- The four new checkboxes are the **only** ones that default to unchecked; the existing
  ones stay checked. Getting this wrong is a silent regression, so T011/T016/T023
  explicitly cover it.
- Absences must never fail a row (constitution Principle III, FR-009) — only title and
  category remain hard requirements.
- Extraction stays pure and chrome-free (Principle I, FR-010); `background.js` only
  orchestrates.
- Every new rule needs a fixture built from real markup (Principle II). Invented fixtures
  pass while production fails.
