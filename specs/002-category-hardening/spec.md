# Feature Specification: Department Category Hardening

**Feature Branch**: `002-category-hardening`

**Created**: 2026-09-22

**Status**: Implemented

**Input**: User description: "需要加一个字段，产品大类 —— 页面左上角红框处，比如 B0CGBXTMRS 是 Automotive，B0HJBCX8VS 是 Apple Products。后面这种不好查的，久留空。"

## Context

The extension already shipped a **大类检查** checkbox (exported as the `Category` column)
backed by `extractCategoryName`. This feature records what verifying it against live
listings changed: the answer was correct for physical-goods departments, but the
extractor was fragile and the field was wrongly treated as mandatory.

Live probing established the three cases that matter:

| Listing | Kind | `#nav-subnav` | Expected category |
| --- | --- | --- | --- |
| B0CGBXTMRS | Automotive parts | present | `Automotive` |
| B0HJBCX8VS | Apple Watch | present | `Apple Products` |
| 0735211299 | Book (Atomic Habits) | **absent** | *(blank)* |
| B08FHBV4ZX | Book (Project Hail Mary) | **absent** | *(blank)* |

The department store tab lives in the page's own sub-navigation bar, which Amazon
renders only for physical-goods departments. Books, Kindle and similar digital
listings have no such bar anywhere in the page — a page-wide scan finds zero
`a.nav-a.nav-b` anchors. That makes a blank category the correct answer, not a bug.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Trust the category column for a mixed batch (Priority: P1)

A seller checks a batch containing both automotive parts and books. The automotive
rows carry their department, the book rows carry a blank, and every row exports —
no row is discarded because one listing type lacks the node.

**Why this priority**: the previous behaviour failed the entire book row with
`未找到大类节点。`, losing the title and every other field that *was* present. Silently
losing good data is the worst outcome for a batch tool.

**Independent Test**: run a book ASIN through the real `background.js` against a
captured book page and assert the row is `success` with a blank category, while an
automotive page in the same suite still yields `Automotive`.

**Acceptance Scenarios**:

1. **Given** a listing whose page has no department subnav, **When** the category
   check is enabled, **Then** the row succeeds, the `Category` cell is blank, and a
   `无大类` note is logged.
2. **Given** a listing whose page has a department subnav, **When** the category
   check is enabled, **Then** the row succeeds and the cell holds the department name.

---

### User Story 2 - Read the department the listing is actually filed under (Priority: P2)

The value must come from the listing's own department subnav, not from whichever
navigation anchor happens to appear first in a full page dump.

**Why this priority**: a page dump carries many nav anchors. Matching the first
`a.nav-a.nav-b` anywhere in the document can attribute an unrelated department to
the listing.

**Independent Test**: feed the parser a page whose first `nav-a nav-b` anchor is a
decoy (`Books`) followed by the real `#nav-subnav`. The answer must be the subnav's
value, not the decoy's.

**Acceptance Scenarios**:

1. **Given** a page with an earlier unrelated store anchor, **When** the category is
   extracted, **Then** the `#nav-subnav` value wins.
2. **Given** a subnav anchor with no `aria-label`, **When** the category is
   extracted, **Then** the `nav-a-content` span text is used.

### Edge Cases

- A subnav anchor with no `aria-label` → fall back to the `.nav-a-content` span.
- A page with no store tab at all → return an empty string, never a neighboring
  department or a breadcrumb guess.
- Script source inside a matched region → rejected, so JavaScript is never exported
  as a category.

## Requirements *(mandatory)*

- **FR-001**: The category MUST be read from the listing's own department
  sub-navigation bar in preference to a page-wide anchor scan.
- **FR-002**: The system MUST fall back to a page-wide store-tab scan only when no
  department subnav is present, so existing behaviour is preserved.
- **FR-003**: A listing without a department subnav MUST yield an empty category.
- **FR-004**: A blank category MUST NOT fail the ASIN row; it MUST be logged as a
  note alongside the other missing-field notes.
- **FR-005**: Only a missing title MAY fail an ASIN row.
- **FR-006**: The extractor MUST remain a pure function of the page HTML with no
  `chrome.*` usage.

## Success Criteria *(mandatory)*

- **SC-001**: A book ASIN exports as `success` with a blank `Category` cell, verified
  against a real captured page.
- **SC-002**: `B0CGBXTMRS` exports `Automotive` and `B0HJBCX8VS` exports
  `Apple Products`, verified against live pages.
- **SC-003**: A decoy earlier anchor does not change the extracted value.
- **SC-004**: The full suite passes with no regression to previously collected fields.

## Assumptions

- Only `www.amazon.com` is in scope, matching the existing constraint.
- The department subnav is the intended meaning of 「产品大类」; the breadcrumb is a
  finer-grained taxonomy and is deliberately not used as a substitute.
