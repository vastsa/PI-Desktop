/**
 * Source contracts for the installed plugin cards and the public review
 * surface. These pin the behaviour the redesign promised: grouped cards, one
 * call to action per enabled card, a read-only review drawer that covers the
 * detail sheet without unmounting it, and a composer that only ever links out
 * to the plugin centre.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readPluginsSourceSync } from "./helpers/source-contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), "utf8");

const pageSrc = readPluginsSourceSync();
const installedPanel = read("../src/features/plugins/InstalledPluginsPanel.tsx");
const marketPanel = read("../src/features/plugins/MarketplacePanel.tsx");
const detailSheet = read("../src/features/plugins/PluginDetailSheet.tsx");
const drawer = read("../src/features/plugins/PluginReviewsDrawer.tsx");
const presentation = read("../src/features/plugins/presentation.tsx");
const hook = read("../src/features/plugins/usePluginReviews.ts");
const pageHook = read("../src/features/plugins/usePluginsPage.ts");
const pluginsCss = read("../src/styles/plugins.css");

test("installed plugins keep their state groups and their disclosure", () => {
  assert.match(installedPanel, /GROUP_LABEL_KEYS\[group\.id\]/);
  assert.match(installedPanel, /className="plugins-list"/);
  assert.match(installedPanel, /role="list"/);
  assert.match(installedPanel, /<PluginRowDetails/);
  assert.match(installedPanel, /<ScopeControl[\s\S]*?compact/);
  assert.match(pageSrc, /GROUP_ORDER: GroupId\[\] = \["attention", "updates", "active", "disabled"\]/);
});

test("an installed card grows one call to action: update, then open panel", () => {
  // The update button names the version it lands on.
  assert.match(installedPanel, /t\("plugins\.updateTo", \{ version: update\.version \}\)/);
  assert.match(installedPanel, /variant="primary"/);
  // Opening the panel is only offered while the plugin is enabled: the host
  // throws for a plugin it has not loaded.
  assert.match(installedPanel, /const canOpenPanel = plugin\.enabled && !!plugin\.ui\?\.panel/);
  assert.doesNotMatch(installedPanel, /\{plugin\.ui\?\.panel \?/);
  // Settings stay behind enabled + declared settings.
  assert.match(installedPanel, /plugin\.enabled && plugin\.settings\?\.length/);
  // A disabled plugin has no primary: both branches read plugin.enabled.
  assert.match(installedPanel, /\{plugin\.enabled && update \? \(/);
});

test("installed and marketplace cards carry the rating chip in their metadata", () => {
  assert.match(presentation, /export function RatingChip/);
  assert.match(presentation, /formatRatingAvg/);
  assert.match(presentation, /summary\.ratingCount <= 0/);
  assert.match(marketPanel, /<RatingChip[\s\S]*?summary=\{reviewSummaries\[item\.id\]\}/);
  assert.match(installedPanel, /<RatingChip[\s\S]*?summary=\{reviewSummaries\[plugin\.id\]\}/);
  // A chip lives inside the existing metadata line, so the card grows no row.
  assert.match(marketPanel, /plugins-card-meta[\s\S]*?<RatingChip/);
  assert.match(installedPanel, /plugins-row-meta[\s\S]*?<RatingChip/);
});

test("the installed card shows the trust glyph only from installed metadata", () => {
  assert.match(installedPanel, /showsVerifiedBadge\(plugin\.marketplace\)/);
  assert.match(installedPanel, /t\("plugins\.verified"\)/);
  // No "verified installed" wording anywhere: the shield carries the claim.
  assert.doesNotMatch(installedPanel, /verified installed/i);
});

test("the detail sheet puts the ratings summary between permissions and versions", () => {
  const permissions = detailSheet.indexOf('t("plugins.permissionsTitle")');
  const reviews = detailSheet.indexOf('t("plugins.reviews.summaryTitle")');
  const versions = detailSheet.indexOf('t("plugins.versions")');
  assert.ok(permissions >= 0 && reviews >= 0 && versions >= 0, "sections missing");
  assert.ok(permissions < reviews && reviews < versions, "ratings summary in the wrong place");
  assert.match(detailSheet, /<ReviewSummaryBlock summary=\{reviewSummary\} locale=\{locale\} \/>/);
  assert.match(detailSheet, /reviewSummary\.ratingCount > 0/);
  assert.match(detailSheet, /t\("plugins\.reviews\.unavailable"\)/);
  assert.match(detailSheet, /<Button[\s\S]*?ref=\{reviewsOpenerRef\}[\s\S]*?t\("plugins\.reviews\.viewAll"\)/);
  // The drawer entry is not gated on the summary: when the summary read
  // fails, the drawer stays reachable for its retry and its link out.
  assert.match(
    detailSheet,
    /<div className="plugins-sheet-reviews-action">[\s\S]*?ref=\{reviewsOpenerRef\}/,
  );
  assert.doesNotMatch(
    detailSheet,
    /\{reviewSummary \? \(\s*<div className="plugins-sheet-reviews-action">/,
  );
});

test("the review drawer mounts over the detail sheet without unmounting it", () => {
  // Same layer, rendered after the sheet: equal z-index, later DOM wins.
  assert.match(detailSheet, /<\/aside>\s*\{reviewsOpen && detail \? \([\s\S]*?<PluginReviewsDrawer/);
  assert.match(drawer, /className="plugins-reviews-layer"/);
  assert.match(pluginsCss, /\.plugins-reviews-layer\s*\{[^}]*position:\s*absolute[^}]*z-index:\s*1/);
  // The covered sheet keeps its mounted state but leaves the interaction
  // order until the drawer closes — its scrim included.
  assert.match(detailSheet, /inert=\{reviewsOpen\}/);
  assert.match(detailSheet, /className="plugins-sheet-scrim"[\s\S]*?inert=\{reviewsOpen\}/);
});

test("Escape closes the top drawer only and focus comes back to its opener", () => {
  // Escape is claimed with preventDefault + stopPropagation before anything
  // under the drawer sees it…
  assert.match(
    drawer,
    /if \(event\.key === "Escape"\) \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*onClose\(\);\s*return;\s*\}/,
  );
  // …while the detail sheet stands down for as long as the drawer owns it.
  assert.match(pageHook, /if \(!selectedId \|\| pendingInstall \|\| installDialogOpen \|\| reviewsId\) return;/);
  // Tab is trapped inside the dialog's own surface, so focus can never reach
  // the covered sheet (also inert) or the page behind it.
  assert.match(drawer, /const focusables = focusableWithin\(root\)/);
  assert.match(drawer, /active === last[\s\S]*?first\.focus\(\)/);
  assert.match(drawer, /active === first[\s\S]*?last\.focus\(\)/);
  assert.match(drawer, /document\.addEventListener\("keydown", onKeyDown, true\)/);
  assert.match(detailSheet, /inert=\{reviewsOpen\}/);
  // Focus lands on the dialog when it opens and returns to the opener after.
  assert.match(drawer, /dialogRef\.current\?\.focus\(\)/);
  assert.match(detailSheet, /wasReviewsOpen\.current && !reviewsOpen/);
  assert.match(detailSheet, /reviewsOpenerRef\.current\?\.focus\(\)/);
  assert.match(drawer, /role="dialog"/);
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /aria-labelledby=\{titleId\}/);
  assert.match(drawer, /tabIndex=\{-1\}/);
});

test("the drawer is a read-only surface whose one write path is the centre page", () => {
  // The scoped primitive, not a raw textarea.
  assert.match(drawer, /<Textarea[\s\S]*?className="plugins-reviews-composer-field"/);
  assert.match(drawer, /import \{ Button, Textarea, TooltipButton, cx \} from "\.\.\/\.\.\/components\/ui"/);
  assert.doesNotMatch(drawer, /<textarea/);
  assert.match(drawer, /disabled/);
  // A real anchor: middle-click and copy-link stay meaningful, and both the
  // primary click and a middle-click route through the system browser.
  assert.match(drawer, /<a\s[\s\S]*?className="plugins-reviews-write"[\s\S]*?href=\{reviewUrl\}/);
  assert.match(drawer, /event\.preventDefault\(\);\s*openReviewLink\(\);/);
  assert.match(drawer, /if \(event\.button !== 1\) return;/);
  // A refused or failed open is reported where the user is looking.
  assert.match(drawer, /await api\.browserOpenExternal\(reviewUrl\)/);
  assert.match(drawer, /showToast\([\s\S]*?variant: "error"/);
  assert.match(drawer, /t\("plugins\.reviews\.composeCta"\)/);
  // No desktop auth, votes, reports, or writes.
  assert.doesNotMatch(drawer, /marketReviewHelpful|marketReport|marketPostReview|fetch\(/);
  assert.doesNotMatch(drawer, /login|signIn/i);
});

test("a review's version reads as self-reported, never as an installed version", () => {
  assert.match(
    drawer,
    /t\("plugins\.reviews\.reviewVersion", \{\s*version: review\.pluginVersion,\s*\}\)/,
  );
  assert.doesNotMatch(drawer, /<span>v\{review\.pluginVersion\}<\/span>/);
});

test("the drawer filters, sorts, and pages with stale answers dropped", () => {
  assert.match(drawer, /REVIEW_SENTIMENTS\.map/);
  assert.match(drawer, /REVIEW_SORTS\.map/);
  assert.match(drawer, /aria-pressed=\{sentiment === value\}/);
  assert.match(drawer, /aria-pressed=\{sort === value\}/);
  assert.match(drawer, /state\.nextCursor/);
  assert.match(drawer, /t\("plugins\.reviews\.loadMore"\)/);
  assert.match(drawer, /t\("plugins\.reviews\.retry"\)/);
  assert.match(drawer, /role="alert"/);
  // The hook invalidates an in-flight answer's identity on every change, and
  // on unmount so a closed drawer never receives an old answer.
  assert.match(hook, /const generation = useRef\(0\)/);
  assert.match(hook, /if \(generation\.current !== request\) return;/);
  assert.match(hook, /return \(\) => \{\s*generation\.current \+= 1;\s*\};/);
  assert.match(hook, /reviewQuery\(pluginId, query\.sentiment, query\.sort\)/);
});

test("every installed and marketplace id is batched without a tab refresh", () => {
  assert.match(
    pageHook,
    /new Set\(\[\.\.\.plugins\.map\(\(plugin\) => plugin\.id\), \.\.\.market\.map\(\(item\) => item\.id\)\]\)/,
  );
  assert.match(pageHook, /api\.marketReviewSummaries\(ids\)/);
  // A successful answer replaces the map for the requested ids: an id the
  // centre omits (archived/unpublished) loses its stale rating.
  assert.match(pageHook, /setReviewSummaries\(nextSummaryMap\(ids, summaries\)\)/);
  assert.doesNotMatch(pageHook, /setReviewSummaries\(\(current\) => \(\{ \.\.\.current/);
  // An unsupported or unreachable centre is unavailable, never zero.
  assert.match(pageHook, /setReviewsStatus\("unavailable"\)/);
  assert.match(pageHook, /setReviewsStatus\("ready"\)/);
});

test("closing the detail closes the drawer with it", () => {
  assert.match(pageHook, /setReviewsId\(null\);\s*setSelectedId\(null\);/);
});

test("the review drawer keeps a real-Chromium user-path fixture", () => {
  // The source and reducer tests above are not the only evidence: the shipped
  // harness drives the real components through card -> summary -> drawer ->
  // filters/paging/error/link -> Escape in Electron. A refactor that breaks
  // that path must break this pin too.
  const harness = readFileSync(
    join(here, "../../../scripts/e2e-plugin-reviews-drawer.mjs"),
    "utf8",
  );
  const fixture = readFileSync(
    join(here, "../../../scripts/e2e/plugin-reviews-drawer.tsx"),
    "utf8",
  );
  assert.match(harness, /pluginReviewsDrawerProbe/);
  assert.match(harness, /pluginReviewsStaleSummaryProbe/);
  assert.match(harness, /pluginReviewsUnavailableSummaryProbe/);
  assert.match(harness, /pluginReviewsBatchProbe/);
  assert.match(harness, /pluginReviewsNarrowDrawerProbe/);
  assert.match(harness, /setContentSize/);
  assert.match(fixture, /usePluginsPage/);
  assert.match(fixture, /pluginReviewsDrawerProbe/);
  assert.match(fixture, /pluginReviewsStaleSummaryProbe/);
  assert.match(fixture, /pluginReviewsUnavailableSummaryProbe/);
  // The two closers: a narrow-viewport geometry pass and the rapid-typing
  // summaries batch that must never render a stale answer.
  assert.match(fixture, /pluginReviewsNarrowDrawerProbe/);
  assert.match(fixture, /pluginReviewsBatchProbe/);
  assert.match(fixture, /drawerRect/);
  assert.match(fixture, /lastIds/);
  assert.match(fixture, /plugins-reviews-write/);
  assert.match(fixture, /key: "Tab"/);
  assert.match(fixture, /key: "Escape"/);
  assert.match(fixture, /inert/);
  assert.match(fixture, /User-reported version/);
});

test("the installed grid keeps a real-Chromium user-path fixture", () => {
  const harness = readFileSync(
    join(here, "../../../scripts/e2e-installed-grid.mjs"),
    "utf8",
  );
  const fixture = readFileSync(
    join(here, "../../../scripts/e2e/installed-grid.tsx"),
    "utf8",
  );
  assert.match(harness, /installedGridLayoutProbe/);
  assert.match(harness, /installedGridActionsProbe/);
  assert.match(fixture, /InstalledPluginsPanel/);
  assert.match(fixture, /PluginDialogs/);
  // The behaviors the probe pins: the real scope control and its menu, the
  // rail shapes, group membership, the 340px grid floor, and the action path.
  assert.match(fixture, /scope-compact-trigger/);
  assert.match(fixture, /scope-compact-menu\.is-open/);
  assert.match(fixture, /plugins-row-controls/);
  assert.match(fixture, /marketInstall/);
  assert.match(fixture, /disablePlugin/);
  assert.match(fixture, /setPluginScope/);
  assert.match(fixture, /gridTemplateColumns/);
  assert.match(fixture, /340/);
});
