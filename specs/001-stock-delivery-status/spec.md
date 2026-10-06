# Feature Specification: Stock and Delivery Status Collection

**Feature Branch**: `001-stock-delivery-status`

**Created**: 2026-09-21

**Status**: Draft

**Input**: User description: "为 AMZ-Check 插件增加「库存与配送状态」采集字段：勾选后，除现有字段外，额外抓取该 ASIN 的库存状态（如 In Stock / Currently unavailable / Only N left in stock）、配送方式（Ships from / Sold by）、预计送达日期区间。每个字段独立复选框，默认不勾选。缺失时留空并记日志，不让整行失败。"

## Context

The extension currently reports whether the Buy Box renders (`Add To Cart` column) but
not what the Buy Box actually says. Sellers evaluating a listing need to know whether it
is in stock, how many units remain, and when it would arrive.

Live probing of two listings established which signals are actually available:

| Signal | In-stock listing (B07FZ8S74R) | Unavailable listing (B0D1XD1ZV3) |
| --- | --- | --- |
| Stock text | `In Stock` in `#availability` | no availability node |
| Delivery promise | `FREE delivery Saturday, September 26` | absent |
| Ships from | present in Buy Box | absent |

So each signal is independently absent on real listings, which drives the requirement that
they are collected and exported independently.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See stock level for a batch of ASINs (Priority: P1)

A seller pastes a list of ASINs, ticks **库存状态**, and after the run each row shows what
the listing said about stock. Listings that are out of stock are visibly different from
listings that are in stock, so the seller can triage without opening every page.

**Why this priority**: Stock level is the single most decision-relevant signal and is the
reason to add this feature at all. Delivered alone it is already useful.

**Independent Test**: Run one in-stock ASIN and one unavailable ASIN with only 库存状态
ticked, and confirm the exported column distinguishes them.

**Acceptance Scenarios**:

1. **Given** a listing showing `In Stock`, **When** the run completes, **Then** the stock
   cell contains the page's stock text.
2. **Given** a listing with no availability node, **When** the run completes, **Then** the
   stock cell is blank, the row still succeeds, and the log notes the missing field.
3. **Given** neither 库存状态 nor any other new checkbox is ticked, **When** the run
   completes, **Then** the exported file is byte-identical to the current behaviour.

---

### User Story 2 - See the delivery promise (Priority: P2)

A seller ticks **配送时效** to learn both delivery windows for each ASIN — what a normal
buyer waits and what Prime shortens it to — so they can compare fulfilment speed across
suppliers and judge whether the listing is worth a Prime-eligible buy.

**Why this priority**: Valuable for sourcing decisions, but secondary to stock level and
derived from the same page regions.

**Independent Test**: Run an ASIN with a delivery promise and confirm the cell holds the
promise text; run an unavailable ASIN and confirm the cell is blank without failing.

**Acceptance Scenarios**:

1. **Given** a listing with both delivery times, **When** the run completes, **Then** the
   cell shows the standard and Prime times on separate lines, each labelled.
2. **Given** a listing whose delivery block is dynamic or absent, **When** the run
   completes, **Then** the delivery cell is blank and the row still succeeds.

---

### User Story 3 - See the fulfilment route (Priority: P3)

A seller ticks **配送方式** to see, in the page's own words, whether Amazon ships the item
or the merchant does.

**Why this priority**: Useful context, but it partially overlaps the existing `Seller`
column, so it is the least urgent of the three.

**Independent Test**: Run a listing with Buy Box fulfilment info and confirm the cell
identifies who ships and who sells; run a listing without it and confirm the row still
succeeds.

**Acceptance Scenarios**:

1. **Given** a listing with Buy Box fulfilment info, **When** the run completes, **Then**
   the cell reads `Ships from Amazon` or `Ships from <merchant>`, matching the page.
2. **Given** a listing with no fulfilment info, **When** the run completes, **Then** the
   cell is blank and the row still succeeds.

### Edge Cases

- **Unavailable listing**: `#availability` contains a `<script>` block rather than stock
  text. The collector must not export script source as the stock value.
- **Dynamic delivery block**: some listings render the delivery promise client-side. The
  collector reads the DOM after the page settles, and leaves the cell blank if the text
  never appears.
- **Both new and existing fields missing**: the row still succeeds as long as title and
  category are present (per the project constitution).
- **Storage/quantity phrasing varies**: `In Stock`, `Only 3 left in stock`, and
  `Currently unavailable` are all valid stock texts and are exported verbatim rather than
  normalised into a fixed vocabulary.
- **Locale**: only `www.amazon.com` is in scope.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The popup MUST offer three independent checkboxes — 库存状态, 配送时效,
  配送方式 — alongside the existing ones.
- **FR-002**: All three MUST default to unchecked, and MUST remain unchecked on a fresh
  profile even though other checkboxes default to checked.
- **FR-003**: An unchecked column MUST be absent from the exported workbook entirely, not
  exported blank.
- **FR-004**: The system MUST extract stock status text from the availability region of
  the listing page.
- **FR-005**: The system MUST NOT treat embedded script source as stock text.
- **FR-006**: The system MUST extract both delivery times when present — the standard
  buyer's and the Prime member's — labelled so they are distinguishable within the cell.
- **FR-007**: The system MUST report the shipment origin verbatim as the page states it
  (`Ships from Amazon`, or `Ships from <merchant name>`), without inventing a value when
  the page states none.
- **FR-009**: A missing value for any of these three fields MUST leave the cell blank, log
  a note, and NOT fail the ASIN row.
- **FR-010**: Extraction MUST remain in `src/core/` as a pure function taking HTML and
  returning fields, with no `chrome.*` usage.
- **FR-011**: Collapsed whitespace and HTML entities in extracted text MUST be normalised
  the same way existing fields are.

### Key Entities

- **Stock record**: the three new values for one ASIN — stock text, delivery promise,
  fulfilment route — stored alongside the existing per-ASIN result.
- **Checkbox selection**: which optional fields the user enabled for this run; determines
  the exported column set.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a listing that is in stock, the stock cell contains the page's own stock
  wording.
- **SC-002**: On an unavailable listing, the row succeeds with a blank stock cell and a
  log note — 0 rows lost to these new fields across a 5-ASIN mixed batch.
- **SC-003**: With all three unchecked, an export is byte-identical to one produced before
  this feature existed.
- **SC-004**: Every extracted value equals what the page displays for that field, verified
  against the live page for at least two listings (one stocked, one unavailable).
- **SC-005**: The existing test suite stays green; new parsing rules are covered by tests
  built on captured real markup.

## Assumptions

- The user is signed in to Amazon and has set a US delivery zip, as the existing feature
  set already requires for the Buy Box to render.
- Availability and delivery text are read from the fully settled DOM, not from static
  HTML, because parts of the delivery block are rendered client-side.
- These fields are additive: no existing column, checkbox, or storage key changes shape.
- Per the constitution, absent optional data never fails a row, and the produced workbook
  is verified rather than assumed.
