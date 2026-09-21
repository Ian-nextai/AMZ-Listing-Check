# AMZ-Check-CRX Constitution

## Core Principles

### I. Pure Core, Thin Chrome Shell

Scraping, parsing, export shaping, and task-state transitions live in `src/core/`
as pure ES modules that import no `chrome.*` API. Only `background.js`, `popup.js`,
`runner.js`, and `offscreen.js` may touch the extension platform.

Rationale: the DOM selectors are the part that breaks when Amazon changes its
markup, so they must be testable under plain Node without a browser. A new
scraper rule that cannot be expressed in `src/core/` is a design smell.

### II. Test-First for Parsing and Export

Any change to `src/core/` requires a test in `tests/` written against real
captured page markup before the implementation changes. Fixtures must come from
actual Amazon HTML, not invented markup — invented fixtures pass while production
fails, which is how the truncated-review-body bug survived.

The suite runs with zero dependencies:

```bash
node --test tests/*.test.mjs
```

Background task lifecycle (start / pause / resume / discard) is covered by
driving `background.js` against a fake `chrome` API, not by mocking the task loop.

### III. Absent Data Is Not an Error

Amazon listings legitimately lack a highlight, reviews, a Buy Box, bullet points,
or A+ images. A missing optional field leaves the cell blank and logs a note.
Only a missing title or category fails an ASIN row.

A row must therefore never be discarded because an optional field was absent, and
the collector must not silently substitute a weaker source (for example falling
back from the reviews page to the truncated detail page) without recording why.

### IV. Zero Build, Vendored Dependencies

The extension loads unpacked with no bundler, transpiler, or `package.json`. Any
third-party library is vendored into `vendor/` and committed. Adding a build step
requires amending this constitution.

The consequence to respect: the vendored SheetJS community build silently ignores
worksheet `!images`, so image embedding is done by injecting OOXML parts directly
(see `src/core/xlsx-image.js`). Do not assume a library feature works because the
API exists — verify the produced artifact.

### V. Verify the Artifact, Not the Source

A change is done when the produced `.xlsx` (or the packaged zip) has been opened
and checked, not when the source looks right. Evidence means: the value parsed out
of a real page, the image present in `xl/media/`, the row count matching Amazon's
own stated review count.

Prefer a live check against a signed-in Chrome session over reasoning about
selectors.

## Additional Constraints

- **Marketplace**: `www.amazon.com` only. Other locales use different DOM and are
  out of scope until explicitly added.
- **Session**: the critical-reviews page requires a signed-in Amazon session. The
  collector detects the sign-in redirect and degrades to the detail page rather
  than failing the row.
- **Rate**: keep the per-ASIN delay configurable and default conservative; this
  tool drives a real browser against a live site.
- **Storage**: `chrome.storage.local` holds task metadata and image URLs only.
  Base64 image payloads stay in memory because a large batch would exhaust the
  quota.
- **Privacy**: no listing data leaves the machine. There is no telemetry.

## Development Workflow

- Work on a branch; the default branch is `main`.
- Before packaging, `node --test tests/*.test.mjs` must be green.
- Bump `manifest.json` `version` on any user-visible change and rebuild
  `amazon-listing-check-extension.zip` from the extension directory.
- When Amazon markup changes, capture the new HTML first and add it as a fixture
  before adjusting selectors.

## Governance

This constitution governs changes to this repository. Amendments are made by
editing this file in a commit that states which principle changed and why. Any
practice listed here that is no longer true of the codebase must be either
restored or removed from the constitution — a stale principle is worse than none.

**Version**: 1.0.0 | **Ratified**: 2026-09-21 | **Last Amended**: 2026-09-21
