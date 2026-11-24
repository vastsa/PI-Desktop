# Architecture budgets

The scripts/check-architecture.mjs checker reports the source-file count, total
physical line count, largest source files, and the >500, >1000, and >2000 LOC
threshold counts for tracked source under apps/, packages/, crates/, and
scripts/. Generated output, dependency trees, and build directories are
excluded.

The checker enforces these limits:

- apps/desktop/electron/main/index.ts is at most 1500 LOC.
- apps/desktop/src/stores/app-store.ts is at most 1000 LOC.
- A newly added ordinary TypeScript or TSX source file is at most 800 LOC,
  unless it has a reasoned entry under typescript in allowlist.json.
- Every Rust source file above 1000 LOC has a reasoned entry under rust in
  allowlist.json.

The checker also reports oversized-file growth. A production TypeScript or
TSX file above 800 LOC, or a Rust file above 1000 LOC, may shrink or keep its
size but should not grow past the size it had at the merge base with
`ARCHITECTURE_BASE` (CI passes the pull-request base). Tests, fixtures, E2E
sources, `.d.ts` files, i18n locales, and changelog catalogs are excluded, and
files that did not exist at the base are covered by the new-file rules above.
Growth is reported as a CI warning annotation and does not fail the check;
setting `ARCHITECTURE_STRICT_GROWTH=1` turns it into a failure. A path listed
with a reason under `growth` in allowlist.json is exempt. The rules live in
scripts/architecture-growth.mjs with unit tests beside them.

The Rust entries currently document legacy modules that were outside the
follow-up split scope. New Rust domain files are expected to remain below the
limit. An allowlist entry records an explicit debt boundary; it does not raise
the general limit for future files.
