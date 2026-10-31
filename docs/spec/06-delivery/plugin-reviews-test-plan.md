# Plugin reviews test plan (desktop)

Portable, repo-resident test plan for the read-only public plugin-reviews
surface: shared types, host-core RPC/HTTP client, Electron IPC bridge, renderer
data layer, installed-grid/detail-sheet UI, review drawer, locale coverage, and
the Electron fixtures.

References used as source of truth:

- `docs/spec/07-plugins/07-plugin-marketplace.md` — marketplace/review behavior.
- `docs/spec/06-delivery/04-e2e-test-plan.md` — fixture conventions and commands.
- Center counterpart: the center repository's `docs/reviews-test-plan.md` (API
  rules and the Go/service/store evidence this plan pairs with).
- Shared types: `packages/shared/src/types/marketplace.ts`; protocol channels in
  `packages/shared/src/protocol.ts`.
- Automated evidence: `apps/desktop/test/market-review-ipc.test.mjs`,
  `plugin-reviews-logic.test.mjs`, `plugin-reviews-surface.test.mjs`,
  `plugins-page-style.test.mjs`; `crates/host-core/src/plugins/reviews.rs` unit
  tests; `crates/host-core/src/rpc/plugin_reviews_rpc_tests.rs`; fixtures under
  `scripts/e2e/` with their runners in `scripts/`.

## 0. Result statuses

| Tag | Meaning |
| --- | --- |
| `verified` | Final actual result recorded in the Final execution record after a run against this worktree. |
| `baseline:fail` | Pre-existing full-suite failure in this environment, not a review regression. |
| `executed; baseline failures` | The command ran end to end; only the known baselines failed — not green. |

Test titles below are copied verbatim from the repository files named in each
row. If a title no longer matches the source, update the row.

## 1. Scope and prohibitions

- Task worktree only; no commits, pushes, tags, release, or packaging.
- Never attach the user's running instance or profile; never use `verify:ui:*`.
  The sanctioned pattern is the headless Electron fixtures in §2.5 with isolated
  `userData` profiles under `.cache/`.
- No broad config or ignore-file changes.
- Desktop stays read-only: no login, posting, votes, reports, or credentials in
  the renderer.
- Tests are the evidence; this plan does not claim any run happened.

## 2. Commands

### 2.1 Windows invocation workaround (tsc / electron-vite)

Canonical scripts are `pnpm --filter @pi-desktop/desktop typecheck`,
`pnpm --filter @pi-desktop/desktop build`, and the repo `pnpm test`. When the
pnpm script shim does not resolve on Windows, invoke the worktree-local binaries
directly with `node` — same inputs and outputs, no configuration change:

```powershell
cd apps/desktop
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/electron-vite/bin/electron-vite.js build
cd ../..
```

Rebuild workspace dists first only if stale (the fixtures resolve them):

```powershell
cd packages/shared;     node node_modules/typescript/bin/tsc -p tsconfig.json; cd ../..
cd packages/plugin-sdk; node node_modules/typescript/bin/tsc -p tsconfig.json; cd ../..
```

### 2.2 Targeted JS tests (final six-file run)

```powershell
node --test apps/desktop/test/market-review-ipc.test.mjs apps/desktop/test/plugin-reviews-logic.test.mjs apps/desktop/test/plugin-reviews-surface.test.mjs apps/desktop/test/plugins-page-style.test.mjs apps/desktop/test/extensions-page.test.mjs apps/desktop/test/settings-dialog-overlay.test.mjs
```

Final independent run: **64/64 pass** — IPC 6, logic 16, surface 14, style 8,
extensions 16, overlay host suite 4. The review cases map to the first four
files plus RVD-UI-14's installed-grid pin; extensions and overlay are the
adjacent regression companions the renderer change touches (the detail sheet
mounts on the viewport overlay host).

### 2.3 Targeted Rust tests

```powershell
cargo test -p host-core --bin pi-desktop-host-core review
cargo fmt --check
cargo clippy -p host-core --all-targets
```

Known unrelated clippy warning (warn-level): `crates/host-core/src/transcripts.rs:893`
`clippy::filter_next`.

### 2.4 Full host-core suite context

```powershell
cargo test -p host-core --bin pi-desktop-host-core
```

Known baseline in this environment: **912 passed; 38 failed; 1 ignored**, all 38
in Windows shell/worktree areas (`background_tasks`, `data_relocation`,
`rpc::*`, `session_worktrees`, `tools::bash_*`, `tools::powershell_*`) — not
review regressions. Report them as `baseline:fail`; do not attempt to fix them
from this plan.

### 2.5 i18n

```powershell
# Catalogue integrity
cd packages/i18n
node node_modules/vitest/vitest.mjs run
cd ../..

# Review-block and key parity (every locale must print reviewsBlock=1 sevenKeys=7)
$root = 'C:\Code\ReactProjects\PI-Desktop\.slim\worktrees\plugin-reviews'
foreach ($l in 'de','en','es','fr','ko','pt-BR','tr','zh-CN','zh-TW') {
  $f = "$root\packages\i18n\src\locales\$l\index.ts"
  $block = (Select-String -Path $f -Pattern '^\s*reviews: \{' -CaseSensitive).Count
  $keys  = (Select-String -Path $f -Pattern 'summaryTitle:|viewAll:|composeHint:|composeCta:|reviewVersion:|filterLabel:|sortLabel:' -CaseSensitive).Count
  "$l : reviewsBlock=$block sevenKeys=$keys"
}
```

`-CaseSensitive` matters: without it the key count reads 8 because
`capabilityFilterLabel` (an unrelated key) also matches `filterLabel:`. Verify
`reviewsBlock=1 sevenKeys=7` per locale.

### 2.6 Electron fixtures (real Chromium, headless)

```powershell
node scripts/e2e-plugin-reviews-drawer.mjs     # five probes: drawer / batch-stale-guard / narrow drawer / stale summary / unavailable summary
node scripts/e2e-installed-grid.mjs            # installed grid + control rails + dialogs
node scripts/e2e-plugin-detail-focus.mjs       # detail-sheet focus interplay
```

Each runner builds the real components with esbuild, loads them in a hidden
Electron window with a private profile, and prints one PASS line per probe. No
install leaves the renderer; no user instance is touched.

## 3. Cases

### 3.1 Shared types and renderer API

| ID | Check | Expected | Status |
| --- | --- | --- | --- |
| RVD-TYP-01 | `PluginReviewSummary` matches the center contract: `ratingAvg: number \| null`, five floor buckets, three sentiment counts | Compiles in shared + desktop typecheck; no private fields (`userId`, `hiddenReason`) in the public type | `verified` (2026-10-16 final typecheck + build) |
| RVD-TYP-02 | `PluginReviewPage` carries `reviews`, `nextCursor: string \| null`, `summary`, host-built `reviewUrl`; `PluginReviewQuery` allows `cursor?/limit?/sentiment?/sort?` | `api.marketReviewSummaries(ids)` / `api.marketReviews(query)` return the shared types through the preload whitelist | `verified` (2026-10-16 final typecheck + build) |

### 3.2 Electron IPC bridge — `market-review-ipc.test.mjs`

| ID | Test title (verbatim) | Expected assertion | Status |
| --- | --- | --- | --- |
| RVD-IPC-01 | review channels are registered and allowed through the preload gate | `IPC.invoke.marketReviewSummaries === "pi-desktop/market/reviewSummaries"`, `marketReviews === "pi-desktop/market/reviews"`, both in `IPC_WHITELIST` | `verified` (2026-10-16 six-file run) |
| RVD-IPC-02 | summary reads forward the ids and return the host payload unchanged | Handler calls host `market.reviewSummaries` with `{pluginIds}` and returns `{summaries}` unchanged | `verified` (2026-10-16 six-file run) |
| RVD-IPC-03 | a missing or malformed id list becomes an empty request, never a crash | Missing payload and `pluginIds: "demo.hello"` both forward `{pluginIds: []}` | `verified` (2026-10-16 six-file run) |
| RVD-IPC-04 | review reads forward the query and return the page unchanged | Full query (incl. `cursor`) forwarded; page returned unchanged | `verified` (2026-10-16 six-file run) |
| RVD-IPC-05 | an unsupported or unreachable center reaches the caller unchanged | Rejection carries `data.errorCode === "PLUGIN_NETWORK"` — no remapping or masking | `verified` (2026-10-16 six-file run) |
| RVD-IPC-06 | review reads require a running host | No host → rejects `host unavailable` | `verified` (2026-10-16 six-file run) |

### 3.3 Host RPC — `plugin_reviews_rpc_tests.rs`

Preconditions: a fixture HTTP server plays the trusted center on a loopback
origin; host-core is driven through the real request handler.

| ID | Test (verbatim) | Expected assertion | Status |
| --- | --- | --- | --- |
| RVD-RPC-01 | `review_summaries_rpc_returns_only_the_centers_answers` | Requested-and-answered ids only; unrequested center answers dropped | `verified` (2026-10-16 hardened Rust run) |
| RVD-RPC-02 | `review_summaries_rpc_dedupes_and_chunks_installed_ids` | Duplicates collapse; chunks of ≤100 ids; requests recorded | `verified` (2026-10-16 hardened Rust run) |
| RVD-RPC-03 | `review_summaries_rpc_is_empty_without_asking_the_center` | Empty ids → `{summaries:{}}` with no HTTP request | `verified` (2026-10-16 hardened Rust run) |
| RVD-RPC-04 | `review_summaries_rpc_rejects_malformed_center_answers` | Bad JSON/shape → `PLUGIN_MARKET_INVALID` | `verified` (2026-10-16 hardened Rust run) |
| RVD-RPC-05 | `review_summaries_rpc_reports_a_legacy_center_as_unavailable` | 404 → `PLUGIN_NETWORK` (unavailable), never zeros | `verified` (2026-10-16 hardened Rust run) |
| RVD-RPC-06 | `review_summaries_rpc_never_fabricates_zeros_when_the_center_is_down` | Down center → error; no zero summaries invented | `verified` (2026-10-16 hardened Rust run) |
| RVD-RPC-07 | `review_summaries_rpc_stays_bounded_when_the_center_stalls` | Stall → fails within the 5 s review deadline | `verified` (2026-10-16 hardened Rust run) |
| RVD-RPC-08 | `review_summaries_rpc_never_holds_the_host_state_lock_across_io` | Trusted origin captured, state lock released before I/O | `verified` (2026-10-16 hardened Rust run) |
| RVD-RPC-09 | `review_summaries_rpc_refuses_a_non_http_center` | `file://` catalog → unavailable, no request | `verified` (2026-10-16 hardened Rust run) |
| RVD-RPC-10 | `review_summaries_rpc_keeps_the_center_bounded` | Request carries 5 s timeout, 1 MiB cap, no redirect following | `verified` (2026-10-16 hardened Rust run) |
| RVD-RPC-11 | `reviews_rpc_returns_the_page_with_a_trusted_review_url` | Page + summary + `reviewUrl` from the effective trusted origin (fixture override included) | `verified` (2026-10-16 hardened Rust run) |
| RVD-RPC-12 | `reviews_rpc_refuses_non_visible_rows_in_the_public_list` | Non-visible row → `PLUGIN_MARKET_INVALID` | `verified` (2026-10-16 hardened Rust run) |
| RVD-RPC-13 | `reviews_rpc_propagates_center_outages` | Center error → propagated as `PLUGIN_NETWORK` | `verified` (2026-10-16 hardened Rust run) |
| RVD-RPC-14 | `reviews_rpc_rejects_invalid_input_before_any_network` | Bad `pluginId`/`limit`/`cursor`/`sentiment`/`sort` → `INVALID_PARAMS`, zero requests | `verified` (2026-10-16 hardened Rust run) |
| RVD-RPC-15 | `reviews_rpc_rejects_pages_that_break_the_public_contract` | Over-limit page, wrong pluginId, bad rating/timestamps/bounds → `PLUGIN_MARKET_INVALID` | `verified` (2026-10-16 hardened Rust run) |
| RVD-RPC-16 | `reviews_rpc_never_follows_redirects` | 3xx from the center → refusal, not a hop | `verified` (2026-10-16 hardened Rust run) |

A 2026-10-16 cross-host run additionally exercised this layer end to end
against a real running center (host stdio RPC, zero-state 9/9 and nonzero 11/11)
— see §5 row 12. It complements, but does not replace, the focused tests above.

### 3.4 Host client bounds/validation — `plugins/reviews.rs`

| ID | Test (verbatim) | Expected | Status |
| --- | --- | --- | --- |
| RVD-CLI-01 | `review_reads_are_bounded` | Timeout 5 s; 1 MiB response cap; 100 summary ids | `verified` (2026-10-16 hardened Rust run) |
| RVD-CLI-02 | `the_origin_keeps_only_the_catalogs_host` | http(s) origins kept incl. port; `file://`, credential URLs, query-smuggled authority refused | `verified` (2026-10-16 hardened Rust run) |
| RVD-CLI-03 | `summaries_batches_dedupe_and_cap_at_one_hundred` | 205 unique + duplicates → chunks 100/100/5, each id once | `verified` (2026-10-16 hardened Rust run) |
| RVD-CLI-04 | `review_urls_stay_on_the_trusted_origin` | Cursor percent-encoded; list/summary/page URLs stay on the origin | `verified` (2026-10-16 hardened Rust run) |
| RVD-CLI-05 | `summary_consistency_is_enforced` | Distribution and sentiments sum to `ratingCount`; zero count ⇔ null average; 0..5 range | `verified` (2026-10-16 hardened Rust run) |
| RVD-CLI-06 | `review_contract_is_enforced` | Right plugin, visible status, 2..=10 half stars, ISO timestamps, body ≤2000 chars, version ≤128, name ≤200; empty version + `editedAt` accepted | `verified` (2026-10-16 hardened Rust run) |

### 3.5 Renderer pure logic — `plugin-reviews-logic.test.mjs`

| ID | Test title (verbatim) | Expected assertion | Status |
| --- | --- | --- | --- |
| RVD-LOG-01 | the official review URL encodes the plugin id into the fallback page | Official URL with percent-encoded id (`/`, space, `#`) | `verified` (2026-10-16 six-file run) |
| RVD-LOG-02 | the page URL wins only when it is a usable http(s) address | Host `reviewUrl` used when http(s); `javascript:`, `data:`, relative, blank → official fallback | `verified` (2026-10-16 six-file run) |
| RVD-LOG-03 | one query key names exactly one plugin, sentiment and sort | Distinct plugin/filter/sort → distinct keys | `verified` (2026-10-16 six-file run) |
| RVD-LOG-04 | mergeReviews appends unseen rows once and keeps the shown order | Deduped append, first-seen order | `verified` (2026-10-16 six-file run) |
| RVD-LOG-05 | rating formatting follows the contract: one decimal, half stars trimmed | `4.5→"4.5"`, `5→"5.0"`, null/NaN → null; half stars trimmed to whole/half star text | `verified` (2026-10-16 six-file run) |
| RVD-LOG-06 | sentiment shares split the good / medium / bad counts into percentages | `[2,1,0] → 67/33/0`; null summary → zeros | `verified` (2026-10-16 six-file run) |
| RVD-LOG-07 | a query carries the page limit and only adds a cursor when paging | Limit always; cursor only when paging | `verified` (2026-10-16 six-file run) |
| RVD-LOG-08 | a first page fills the list and closes the load | Ready state, rows, `nextCursor`, summary, effective URL | `verified` (2026-10-16 six-file run) |
| RVD-LOG-09 | a summary of zero reviews is carried through as zero, not as unavailable | `ratingCount 0`, null average — distinct from unavailable | `verified` (2026-10-16 six-file run) |
| RVD-LOG-10 | a summary answer replaces the requested ids, so an omitted id loses its rating | Requested subset replaces the map; unrequested key never enters; zero stays zero (stale-chip behavior) | `verified` (2026-10-16 six-file run) |
| RVD-LOG-11 | a page that does not carry reviewUrl falls back to the official page | Missing `reviewUrl` → official URL | `verified` (2026-10-16 six-file run) |
| RVD-LOG-12 | an answer for another query cannot reach the list on screen | Late answer for an abandoned key → dropped | `verified` (2026-10-16 six-file run) |
| RVD-LOG-13 | switching filter drops the old rows; retrying the same filter keeps them | Filter switch clears to loading; same-key retry keeps rows | `verified` (2026-10-16 six-file run) |
| RVD-LOG-14 | paging appends without repeating a row that moved between pages | Dedup by id; cursor cleared at end | `verified` (2026-10-16 six-file run) |
| RVD-LOG-15 | a failure keeps readable rows and only replaces an empty list | Rows kept on later-page failure; first-page failure is an error state | `verified` (2026-10-16 six-file run) |
| RVD-LOG-16 | a failure for a query that is no longer on screen is ignored | Stale failure → state unchanged | `verified` (2026-10-16 six-file run) |

### 3.6 UI source contracts — `plugin-reviews-surface.test.mjs`

| ID | Test title (verbatim) | Expected assertion | Status |
| --- | --- | --- | --- |
| RVD-UI-01 | installed plugins keep their state groups and their disclosure | Group order `attention, updates, active, disabled`; `role="list"`; details disclosure kept | `verified` (2026-10-16 six-file run) |
| RVD-UI-02 | an installed card grows one call to action: update, then open panel | Update button names the target version; panel only when enabled+declared; settings behind enabled+declared; disabled card has no primary | `verified` (2026-10-16 six-file run) |
| RVD-UI-03 | installed and marketplace cards carry the rating chip in their metadata | `RatingChip` inside the existing meta line; hidden when `ratingCount <= 0` | `verified` (2026-10-16 six-file run) |
| RVD-UI-04 | the installed card shows the trust glyph only from installed metadata | Shield from installed trust tier; no "verified installed" wording | `verified` (2026-10-16 six-file run) |
| RVD-UI-05 | the detail sheet puts the ratings summary between permissions and versions | Section order Permissions < Ratings & reviews < Versions; unavailable copy; drawer entry not gated on the summary (unavailable-entry behavior) | `verified` (2026-10-16 six-file run) |
| RVD-UI-06 | the review drawer mounts over the detail sheet without unmounting it | Same layer, later DOM; absolute z-index 1; sheet + scrim `inert` while open | `verified` (2026-10-16 six-file run) |
| RVD-UI-07 | Escape closes the top drawer only and focus comes back to its opener | Escape claimed before the sheet; Tab trap wraps both directions; dialog focus + return to opener | `verified` (2026-10-16 six-file run) |
| RVD-UI-08 | the drawer is a read-only surface whose one write path is the centre page | Disabled scoped-composer field; real anchor; click + middle-click open via `api.browserOpenExternal`; failure toast; no login/vote/report/`fetch` | `verified` (2026-10-16 six-file run) |
| RVD-UI-09 | a review's version reads as self-reported, never as an installed version | `reviewVersion` label; no bare `v{version}` span | `verified` (2026-10-16 six-file run) |
| RVD-UI-10 | the drawer filters, sorts, and pages with stale answers dropped | Sentiment/sort groups with `aria-pressed`; cursor load-more; retry; `role="alert"`; generation invalidation incl. unmount | `verified` (2026-10-16 six-file run) |
| RVD-UI-11 | every installed and marketplace id is batched without a tab refresh | One `Set` of installed+market ids → one summaries call; success replaces via `nextSummaryMap(ids, …)`; failure → unavailable, never zero | `verified` (2026-10-16 six-file run) |
| RVD-UI-12 | closing the detail closes the drawer with it | Drawer id and selection cleared together | `verified` (2026-10-16 six-file run) |
| RVD-UI-13 | the review drawer keeps a real-Chromium user-path fixture | Harness pins the drawer probes — now five, including `pluginReviewsBatchProbe` and `pluginReviewsNarrowDrawerProbe` (with the 320×720 `setContentSize` switch); fixture drives the page hook, Tab/Escape, inert, write link | `verified` (2026-10-16 six-file run + 2026-10-17 probes) |
| RVD-UI-14 | the installed grid keeps a real-Chromium user-path fixture | Pins the installed-grid harness + fixture: `installedGridLayoutProbe`/`installedGridActionsProbe`, real `InstalledPluginsPanel` + `PluginDialogs`, the scope control and its menu (`scope-compact-trigger`, `scope-compact-menu.is-open`), the rail (`plugins-row-controls`), the action path (`marketInstall`, `disablePlugin`, `setPluginScope`), and the 340px grid floor (`gridTemplateColumns`) | `verified` (2026-10-16 six-file run) |

### 3.7 Page integration (fetcher semantics)

| ID | Check | Expected | Status |
| --- | --- | --- | --- |
| RVD-PAGE-01 | Summary batch under rapid typing: settled cards come from the final query, a held earlier answer cannot overwrite them | `pluginReviewsBatchProbe` (ordering-controlled — the first summaries answer is gated and released only after the final answer lands; **no wall-clock debounce claim**): settled cards are exactly the final query's plugins; the fresh chip reads 4.5 (3); the plugin the final batch does not rate shows no chip; the final batch's requested ids equal the displayed ids; after the held answer is released the fresh chip is unchanged and no stale chip appears | `verified` (2026-10-17 batch-stale-guard probe) |
| RVD-PAGE-02 | Summary failure is isolated | Unavailable status; install/update never waits on it | `verified` (2026-10-16 six-file run / drawer probes) |
| RVD-PAGE-03 | Center predating the review API | Unavailable — distinct from zero; no fabricated zeros | `verified` (2026-10-16 six-file run / drawer probes) |
| RVD-PAGE-04 | Drawer list failure independent from summary | Drawer retries its own list; disabled composer + link out remain reachable | `verified` (2026-10-16 six-file run / drawer probes) |

### 3.8 Electron fixture E2E — `scripts/e2e-plugin-reviews-drawer.mjs`

| ID | Probe (verbatim) | Steps / expected | Status |
| --- | --- | --- | --- |
| RVD-E2E-01 | `pluginReviewsDrawerProbe` | Card chip (`aria-label "Rated 4.5 out of 5 from 3 ratings"`, text `4.5 (3)`) → detail section order → opener scrolled into view → drawer takes focus, sheet+scrim inert → Tab trap wraps both ways → first page with "User-reported version v1.2.0" → Load more appends r1/r2/r3 deduplicated → slow "All" answer outrun by a filter switch is dropped → Negative failure shows error + retry recovers → write link href is the host URL; primary and middle-click open it; right-click does not → open failure toast → Escape closes only the drawer, focus and sheet scroll restored | `verified` (2026-10-16 six-probe rerun) |
| RVD-E2E-02 | `pluginReviewsStaleSummaryProbe` | A summaries refresh whose answer omits a requested id removes that plugin's stale rating chip | `verified` (2026-10-16 six-probe rerun) |
| RVD-E2E-03 | `pluginReviewsUnavailableSummaryProbe` | Summary read fails → no chip; detail shows "Ratings aren't available from this source." with the drawer entry present; drawer retry state, disabled composer, official fallback link; retry recovers the list and the host `reviewUrl` replaces the fallback | `verified` (2026-10-16 six-probe rerun) |

The drawer harness runs five probes: the three above plus `pluginReviewsBatchProbe`
(RVD-PAGE-01) and `pluginReviewsNarrowDrawerProbe` (RVD-NARROW-01, with the
320×720 `useContentSize` switch). Full run: 5/5 PASS.

### 3.9 Installed grid, detail focus, and the installed-card fixture

| ID | Runner | Scope / expected | Status |
| --- | --- | --- | --- |
| RVD-E2E-04 | `node scripts/e2e-installed-grid.mjs` (`scripts/e2e/installed-grid.tsx`), probes `installedGridLayoutProbe` + `installedGridActionsProbe` | Real `InstalledPluginsPanel` + `PluginDialogs` in a 1100×900 fixture window, only the IPC boundary fixtured; seven plugins (error, disabled-with-update, plain disabled, panel-only, settings-only, updater, long id). Layout probe PASS: groups/members/error, rail order + disabled gating, disclosure, real scope menu, chip inline + long-id truncation, 340px grid floor + sub-340 fallback, narrow rail wrap. Actions probe PASS: update→permission→`marketInstall`(v1.2.3), panel id, settings sheet opens/closes, overflow auto-update false + uninstall. Reported 2/2 pass; the final rerun decides | `verified` (2026-10-16 six-probe rerun, 2/2) |
| RVD-E2E-05 | `node scripts/e2e-plugin-detail-focus.mjs` (`scripts/e2e/plugin-detail-focus.tsx`) | Detail-sheet focus/scroll interplay while the summary read returns `{}` — sheet behavior independent of the review surface | `verified` (2026-10-16 six-probe rerun) |

**Installed-card real-component fixture (landed).** Runner
`scripts/e2e-installed-grid.mjs`, fixture `scripts/e2e/installed-grid.tsx`,
probes `installedGridLayoutProbe` (groups, rail, disclosure, scope, meta, grid)
and `installedGridActionsProbe` (update path, panel, settings, row menu). Only
the IPC boundary is fixtured; nothing installs outside the renderer. Rows below
state only what the fixture asserts.

| ID | Case | Steps / expected (as asserted by the fixture) | Status |
| --- | --- | --- | --- |
| RVD-GRID-01 | Grid — wide | At the 1100px host, `.plugins-list` computed columns are ≥2 and every column is ≥340−1px (the 340px floor) | `verified` (2026-10-16 installed-grid layout probe) |
| RVD-GRID-02 | Grid — narrow | Host forced to 300px: exactly one column ≤300px; the grid does not overflow horizontally (`scrollWidth <= clientWidth + 1`); the card's right edge stays inside the grid | `verified` (2026-10-16 installed-grid layout probe) |
| RVD-GRID-03 | Control order | Updater rail exactly 4: scope-control → primary "Update to v1.2.3" → settings icon (`aria-label "Plugin settings"`) → menu wrap; panel-only rail 3: scope → "Open panel" → menu; settings-only rail 3 with the settings icon second; each disabled card: rail 2 (scope + menu), no primary, no settings icon, no panel action | `verified` (2026-10-16 installed-grid layout probe) |
| RVD-GRID-04 | Update CTA | Primary click → permission dialog "Install Acme Updater?" naming "v1.2.3" → accept → `marketInstall` recorded as `{id:"acme.updater", version:"1.2.3", enable:true, autoUpdate:true}`; the install dialog steps aside | `verified` (2026-10-16 installed-grid actions probe) |
| RVD-GRID-05 | Panel CTA | "Open panel" on the panel-only card → `openPluginPanel("acme.panel")`; disabled cards offer no panel action | `verified` (2026-10-16 installed-grid actions probe) |
| RVD-GRID-06 | Settings | Settings icon → `.plugins-settings-modal` titled "Acme Updater settings"; the close control dismisses it | `verified` (2026-10-16 installed-grid actions probe) |
| RVD-GRID-07 | Groups, membership, disabled states | Seven fixtures in four groups: Needs attention 1 (Acme Broken, error text "Manifest could not be read"); Updates available 2 (Acme Dormant, Acme Updater); Active 3 (Acme Panel, Acme Settings, Long Identifier); Turned off 1 (Acme Off). Disabled gating as in GRID-03 | `verified` (2026-10-16 installed-grid layout probe) |
| RVD-GRID-08 | Scope | Compact scope trigger (first control) opens `.scope-compact-menu.is-open` with 3 `role="menuitemradio"` choices; "Off" → `disablePlugin("acme.updater")` and the menu closes; "Projects" → `setPluginScope("acme.updater", {mode:"projects", projects:[]})` | `verified` (2026-10-16 installed-grid layout probe) |
| RVD-GRID-09 | Row overflow menu | Trigger `aria-label "Actions for Acme Updater"`: "Disable auto-update" → `setPluginAutoUpdate("acme.updater", false)`, menu closes; reopen → "Uninstall" → `uninstallPlugin("acme.updater")`. Source-level (not exercised — no such plugin seeded): Reload appears only for `source === "dev"`, and bundled plugins omit Uninstall | `verified` (2026-10-16 installed-grid actions probe) |
| RVD-GRID-10 | Disclosure | Updater's `details.plugins-row-details` starts closed, opens on summary click, and its body includes "Capabilities"; the settings-only card has no details section | `verified` (2026-10-16 installed-grid layout probe) |
| RVD-GRID-11 | Rating chip geometry | Chip sits inside `.plugins-row-meta` (chipRect within metaRect ±1px — it does not wrap onto its own line); meta line height ≤24px; the zero-summary card renders no chip; the long-id card's `.plugins-row-id` truncates (`scrollWidth > clientWidth + 8`) while staying inside the card. No card-height comparison between chip present/absent is asserted here | `verified` (2026-10-16 installed-grid layout probe) |

### 3.10 Locales, accessibility, narrow width, style

| ID | Check | Expected | Status |
| --- | --- | --- | --- |
| RVD-I18N-01 | Review strings in all nine locales (`de,en,es,fr,ko,pt-BR,tr,zh-CN,zh-TW`) | Every locale carries exactly one nested `reviews: {` block and all seven key names (`summaryTitle`, `viewAll`, `composeHint`, `composeCta`, `reviewVersion`, `filterLabel`, `sortLabel`); the §2.5 check prints `reviewsBlock=1 sevenKeys=7` per locale; vitest catalogue suite green | `verified` (catalogue 30/30 + shared 1272; locale parity re-checked) |
| RVD-A11Y-01 | Accessible names/states of the drawer surface | `role="dialog"`, `aria-modal="true"`, labelled title; filters/sorts `aria-pressed`; list label; load error `role="alert"`; star rating `role="img"` with a rating label; Tab trap + inert; Escape returns focus | `verified` (2026-10-16 six-probe rerun) |
| RVD-NARROW-01 | Narrow drawer at 320×720 (real geometry) | `pluginReviewsNarrowDrawerProbe` on the real components with the hidden window resized to 320×720 (`useContentSize`): drawer rect fully inside the viewport; document and drawer-body have no horizontal overflow; 7+ controls (4 sentiment, 2 sort, close, write link) stay inside the drawer; filter/sort `aria-pressed`; body scrolls (`scrollTop > 0`); composer inside the viewport; write link routes `browserOpenExternal(REVIEW_URL)`; close leaves the detail sheet. Harness applies `base.css` and the repo's reduced-motion `animation: none`. **320 is the only asserted narrow width** — 375 is covered by the probe's `<= 375` guard, not a second run | `verified` (2026-10-17 narrow-drawer probe) |
| RVD-STYLE-01 | `plugins-page-style.test.mjs` — "review surfaces use design tokens in both themes" | Chip tabular numerals; summary uses `--plugins-tile`; scrim uses `--ds-modal-veil`; drawer reserves `--ds-toolbar-height`; composer field token; write link styled | `verified` (2026-10-16 six-file run) |

### 3.11 Non-interference invariants

| ID | Check | Expected | Status |
| --- | --- | --- | --- |
| RVD-REL-01 | Center downtime / legacy center never affects install, update, or plugin actions | Review reads fail in isolation; installed grid and marketplace actions stay usable while summary/list reads fail | `verified` (probe + focused-test evidence, 2026-10-16) |
| RVD-REL-02 | No renderer network or auth for reviews | Only host RPC channels; no `fetch` in the drawer; `browserOpenExternal` is the sole external navigation, host-URL only | `verified` (probe + focused-test evidence, 2026-10-16) |
| RVD-REL-03 | URL trust | No URL derived from package or review content; `reviewUrl` only from the effective trusted origin (fixture override included) | `verified` (probe + focused-test evidence, 2026-10-16) |

## 4. Final evidence summary

All behavior rows below are closed on the frozen source; the execution record in
§5 carries the artifacts.

| Behavior | Cases |
| --- | --- |
| Unavailable entry retained (drawer entry, retry, link out) | Probe verified 2026-10-16 (RVD-E2E-03); RVD-UI-05 verified in the six-file run; RVD-PAGE-04 verified (drawer failure independence pinned by the probes) |
| Stale chip omission removes the chip | Probe verified 2026-10-16 (RVD-E2E-02); RVD-LOG-10 / RVD-UI-11 verified in the six-file run |
| Bridge hardening: response identity, redirect refusal, time bounds | Verified — 22 Rust tests (16 RPC + 6 client-unit) passed after hardening with no Rust source changes since (`host-core-after-hardening.txt`) |
| Installed-card real-component fixture | Verified 2026-10-16 (RVD-E2E-04 + RVD-GRID-01 … RVD-GRID-11); RVD-UI-14 verified in the six-file run |

## 5. Final execution record (this run)

Local execution environment for this run: Windows / PowerShell; isolated
Electron fixture profiles under `.cache/`; worktree revision recorded per row.
Results below are the final recorded execution; each row cites its evidence
artifact. Sources are frozen; the two manual geometry/behavior checks remain
listed as manual, separately from the automated evidence.

Dated result for this run: **2026-10-16/17, coordinator-verified** — 64 targeted
JS tests across the six files and the eight Electron probes (5 drawer + 2
installed-grid + 1 detail-focus) pass on the current exact source; full desktop
typecheck and the production `electron-vite` build exit 0 (main/preload/renderer
built). The cross-host contract check (zero 9/9, nonzero 11/11) was independently
read and accepted. No further desktop production-code changes are expected for
this run; this plan is the only remaining mutable artifact.

| # | Command / path | Status | Evidence recorded | Notes |
| --- | --- | --- | --- | --- |
| 1 | `node --test … market-review-ipc / plugin-reviews-logic / plugin-reviews-surface / plugins-page-style / extensions-page / settings-dialog-overlay …` | verified | 2026-10-16 coordinator targeted six-file run: 64/64 pass (shell output) | Per file: IPC 6, logic 16, surface 14, style 8, extensions 16, overlay host suite 4. Confirm the overlay filename against the run's shell output when archiving the log |
| 2 | `cargo test -p host-core --bin pi-desktop-host-core review` | verified | 22 Rust tests (16 RPC + 6 client-unit) passed after hardening; no Rust source changes since (`host-core-after-hardening.txt`) | Accepted existing evidence — no gratuitous rerun |
| 3 | `cargo fmt --check` / `cargo clippy -p host-core --all-targets` | verified | fmt clean; clippy exit 0 (`clippy-after-hardening.txt`) | Known unrelated warn at `transcripts.rs:893` |
| 4 | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` (desktop) | verified | 2026-10-16 final rerun on the F7/F8 code: exit 0 (`plugin-reviews-desktop-finalbuild.log`) | Full desktop typecheck passed |
| 5 | `node node_modules/electron-vite/bin/electron-vite.js build` (desktop) | verified | 2026-10-16 final rerun on the F7/F8 code: exit 0 (`plugin-reviews-desktop-finalbuild.log`) | main/preload/renderer built; only the pre-existing large-chunk warning |
| 6 | `node scripts/e2e-plugin-reviews-drawer.mjs` | verified | 2026-10-17: drawer harness 5/5 PASS, exit 0 (incl. the batch-stale-guard and narrow-drawer probes) | Total Electron probes now 8 (5 drawer + 2 grid + 1 detail-focus); supersedes the earlier 3-probe drawer run |
| 7 | `node scripts/e2e-installed-grid.mjs` (`installedGridLayoutProbe` + `installedGridActionsProbe`) | verified | 2026-10-16 coordinator six-probe rerun (exit 0) | Installed grid 2/2; carries RVD-GRID-01 … 11 |
| 8 | `node scripts/e2e-plugin-detail-focus.mjs` | verified | 2026-10-16 coordinator six-probe rerun (exit 0) | Detail focus passed |
| 9 | i18n §2.5 checks + vitest catalogue suite | verified | Catalogue suite 30/30 and shared 1272 passed (recorded earlier); `reviewsBlock=1 sevenKeys=7` re-checked mechanically on the current source for all nine locales | Review keys present in every locale; no UI reruns |
| 10 | `cargo test -p host-core --bin pi-desktop-host-core` (full) | executed; baseline failures | 912 passed / 38 `baseline:fail` / 1 ignored (`host-core-after-hardening.txt`) | Environment failures only; not a green suite |
| 11 | Narrow-window check | verified | `pluginReviewsNarrowDrawerProbe` at 320×720 (2026-10-17): no overflow, controls inside, body scrolls, composer inside, link routes, close leaves the sheet. Installed-grid narrow covered separately by the 300px probe (RVD-GRID-02) | 320 is the only asserted narrow width; 375 covered by the `<= 375` guard only |
| 12 | Cross-host contract check (host stdio RPC → real center) | verified | 2026-10-16 — zero run 9/9 + nonzero run 11/11, independently read and accepted | Same host binary (no rebuild); nonzero seed via the center's real write API; no private fields despite one report fixture. Complements the focused RVD-RPC-01…16 tests, which passed after hardening (row 2) |
| 13 | Final oracle gate | PASS | All eight known findings closed on the frozen source; no further production fixes expected | Cross-repo gate covering both plans |

## 6. Change control

- This document is the repo deliverable; corrections land here only.
- Final results are recorded in §5 and the affected case rows are updated in
  place.
- No commits, pushes, tags, or packaging from this plan.
