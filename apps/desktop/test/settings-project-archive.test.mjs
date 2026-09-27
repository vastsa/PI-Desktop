import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const settingsPageSource = await readFile(
  new URL("../src/pages/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const projectsPageSource = await readFile(
  new URL("../src/pages/ProjectsPage.tsx", import.meta.url),
  "utf8",
);
const settingsSearchSource = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const searchDialogSource = await readFile(
  new URL("../src/components/SearchDialog.tsx", import.meta.url),
  "utf8",
);
const appSource = await readFile(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);
const projectsStyleSource = await loadStyles();
// The archive partial on its own: `loadStyles` inlines the whole cascade, so
// assertions that a rule is *gone* have to look at the file that owned it.
const projectsPartialSource = await readFile(
  new URL("../src/styles/projects.css", import.meta.url),
  "utf8",
);

test("settings owns the project archive destination", () => {
  assert.match(settingsSearchSource, /id: "projects"/);
  assert.match(settingsSearchSource, /titleKey: "settings\.projectArchive"/);
  assert.match(settingsPageSource, /projects: <IconArchive/);
  assert.match(settingsPageSource, /tab === "projects" && <ProjectsPage/);
  const navOrder = ["general", "agent", "import", "projects", "about"].map(
    (id) => settingsSearchSource.indexOf(`id: "${id}"`),
  );
  assert.ok(navOrder.every((index) => index >= 0));
  assert.deepEqual(navOrder, [...navOrder].sort((a, b) => a - b));
});

test("project archive includes archived projects without a visibility toggle", () => {
  assert.doesNotMatch(
    projectsPageSource,
    /filter\(\(project\).*project\.archived/s,
  );
  assert.doesNotMatch(projectsPageSource, /setSessionArchiveVisibility/);
  assert.match(projectsPageSource, /setSettingsTab\("projects"\)/);
});

test("project archive makes project sessions searchable and progressively visible", () => {
  assert.match(projectsPageSource, /sessionMatchesQuery/);
  assert.match(projectsPageSource, /sessionTimestamp\(b\.updatedAt\) - sessionTimestamp\(a\.updatedAt\)/);
  assert.doesNotMatch(projectsPageSource, /\.slice\(0, 4\)/);
  assert.match(projectsPageSource, /INITIAL_VISIBLE_SESSION_COUNT = 8/);
  assert.match(projectsPageSource, /project\.sessionsCount/);
  assert.match(projectsPageSource, /project\.showMoreSessions/);
  assert.match(projectsPageSource, /project\.showFewerSessions/);
  assert.match(projectsPageSource, /projects-detail-task-updated/);
});

test("project archive is no longer a standalone app page", () => {
  assert.doesNotMatch(searchDialogSource, /page: "projects"/);
  assert.doesNotMatch(appSource, /page === "projects"/);
});

test("project archive renders the intro, toolbar, and grouped index", () => {
  // One quiet description line and no counter run: the per-group counts in the
  // panel are the only totals the destination shows.
  assert.match(projectsPageSource, /projects-intro-desc/);
  assert.match(projectsPageSource, /project\.archiveSubtitle/);
  // The counter run is gone, so its markup and its four label keys are retired.
  assert.doesNotMatch(projectsPageSource, /projects-intro-stat/);
  assert.doesNotMatch(projectsPageSource, /project\.stat[A-Z]/);

  // Toolbar: clearable search with a live match count plus a sort control.
  assert.match(projectsPageSource, /projects-search-clear/);
  assert.match(projectsPageSource, /project\.clearSearch/);
  assert.match(projectsPageSource, /projects-result-count[^]*aria-live="polite"/);
  assert.match(projectsPageSource, /project\.resultCount/);
  assert.match(projectsPageSource, /"settings-segment projects-sort"/);
  assert.match(projectsPageSource, /aria-pressed=\{sort === mode\}/);
  assert.match(projectsPageSource, /project\.sortRecent/);
  assert.match(projectsPageSource, /project\.sortName/);

  // Grouped index: archived records are a trailing section, not a filter.
  assert.match(
    projectsPageSource,
    /GROUP_ORDER: GroupId\[\] = \["pinned", "projects", "archived"\]/,
  );
  assert.match(projectsPageSource, /pinned: "project\.groupPinned"/);
  assert.match(projectsPageSource, /projects: "project\.groupProjects"/);
  assert.match(projectsPageSource, /archived: "project\.groupArchived"/);
  assert.match(projectsPageSource, /projects-group-count/);
  assert.match(projectsPageSource, /projects-empty/);

  // One workbench: the groups are strips inside a single elevated panel.
  assert.equal(
    projectsPageSource.match(/settings-panel projects-list/g)?.length,
    1,
  );
  // Each group keeps its name in the accessibility tree and owns the list role,
  // so the strip never becomes a non-listitem child of a list.
  assert.match(projectsPageSource, /aria-labelledby=\{`projects-group-\$\{group\.id\}`\}/);
  assert.match(projectsPageSource, /<h3 className="projects-group-label"/);
  assert.match(projectsPageSource, /className="projects-group-rows" role="list"/);
  assert.doesNotMatch(projectsPageSource, /projects-group-head" role="presentation"/);
});

test("pinned projects use a distinct star glyph", () => {
  assert.match(projectsPageSource, /IconStar/);
  assert.match(
    projectsPageSource,
    /projects-glyph[^]*project\.pinned \? \([\s\S]*<IconStar size=\{15\} fill="currentColor" aria-hidden \/>[\s\S]*<IconFolder size=\{15\} aria-hidden \/>/,
  );
});

test("project archive row menu closes on escape and outside press", () => {
  assert.match(projectsPageSource, /addEventListener\("mousedown", onPointerDown\)/);
  assert.match(projectsPageSource, /addEventListener\("keydown", onKeyDown\)/);
  assert.match(projectsPageSource, /removeEventListener\("mousedown", onPointerDown\)/);
  assert.match(projectsPageSource, /removeEventListener\("keydown", onKeyDown\)/);
  assert.match(projectsPageSource, /"Escape"[^]*setMenuFor\(null\)/);
});

test("project archive styles group archived rows instead of hiding them", () => {
  assert.match(projectsStyleSource, /\.projects-intro-desc\s*\{/);
  assert.match(projectsStyleSource, /\.projects-sort-btn\.active\s*\{/);
  assert.match(projectsStyleSource, /\.projects-group-head\s*\{/);
  assert.doesNotMatch(projectsStyleSource, /\.projects-row-block\.archived\s*\{\s*display:\s*none/);
  assert.doesNotMatch(projectsStyleSource, /\.projects-row-block\.archived\s*\{\s*opacity/);

  // The decorative hero card is gone: no hero rules and no gradient fill.
  assert.doesNotMatch(projectsPartialSource, /projects-hero/);
  assert.doesNotMatch(projectsPartialSource, /projects-stat/);
  assert.doesNotMatch(projectsPartialSource, /linear-gradient/);
});
