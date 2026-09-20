import { readAppSource, readSettingsSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const settingsPageSource = await readSettingsSource();
const projectsPageSource = await readFile(
  new URL("../src/pages/ProjectsPage.tsx", import.meta.url),
  "utf8",
);
const projectsIndexSource = await readFile(
  new URL("../src/features/projects/ProjectArchiveIndex.tsx", import.meta.url),
  "utf8",
);
const projectsDetailSource = await readFile(
  new URL("../src/features/projects/ProjectDetailPanel.tsx", import.meta.url),
  "utf8",
);
const projectArchiveSource = await readFile(
  new URL("../src/lib/project-archive.ts", import.meta.url),
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
const appSource = await readAppSource();
const projectsStyleSource = await loadStyles();
const projectsPartialSource = await readFile(
  new URL("../src/styles/projects.css", import.meta.url),
  "utf8",
);
const archiveUiSource = `${projectsPageSource}\n${projectsIndexSource}\n${projectsDetailSource}\n${projectArchiveSource}`;

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
  assert.doesNotMatch(projectArchiveSource, /setSessionArchiveVisibility/);
  assert.match(projectArchiveSource, /Archived records are grouped last/);
  assert.match(projectsPageSource, /setSettingsTab\("projects"\)/);
  assert.match(projectArchiveSource, /if \(project\.archived === true\) return "archived"/);
});

test("project archive makes project sessions searchable and progressively visible", () => {
  assert.match(archiveUiSource, /sessionMatchesQuery/);
  assert.match(
    projectArchiveSource,
    /sessionTimestamp\(b\.updatedAt\) - sessionTimestamp\(a\.updatedAt\)/,
  );
  assert.doesNotMatch(archiveUiSource, /\.slice\(0, 4\)/);
  assert.match(projectArchiveSource, /INITIAL_VISIBLE_SESSION_COUNT = 8/);
  assert.match(projectsDetailSource, /project\.sessionsCount/);
  assert.match(projectsDetailSource, /project\.showMoreSessions/);
  assert.match(projectsDetailSource, /project\.showFewerSessions/);
  assert.match(projectsDetailSource, /projects-detail-task-updated/);
});

test("project archive is no longer a standalone app page", () => {
  assert.doesNotMatch(searchDialogSource, /page: "projects"/);
  assert.doesNotMatch(appSource, /page === "projects"/);
});

test("project archive is a toolbar over a list, with no page-level prose", () => {
  // Sibling destinations carry no description line, so this one does not
  // either: the toolbar is the first thing under the title, and the intro
  // element and its catalog key are gone rather than merely hidden.
  assert.doesNotMatch(projectsPageSource, /projects-intro/);
  assert.doesNotMatch(projectsPageSource, /project\.archiveSubtitle/);
  assert.doesNotMatch(projectArchiveSource, /archiveSubtitle/);
  assert.doesNotMatch(projectsPageSource, /projects-intro-stat/);
  assert.doesNotMatch(archiveUiSource, /archiveSubtitle/);

  assert.match(projectsPageSource, /projects-search-clear/);
  assert.match(projectsPageSource, /project\.clearSearch/);
  assert.match(projectsPageSource, /projects-result-count[^]*aria-live="polite"/);
  assert.match(projectsPageSource, /project\.resultCount/);
  assert.match(projectsPageSource, /"settings-segment projects-sort"/);
  assert.match(projectsPageSource, /aria-pressed=\{sort === mode\}/);
  assert.match(projectsPageSource, /project\.sortRecent/);
  assert.match(projectsPageSource, /project\.sortName/);

  assert.match(
    projectArchiveSource,
    /GROUP_ORDER: GroupId\[\] = \["pinned", "projects", "archived"\]/,
  );
  assert.match(projectArchiveSource, /pinned: "project\.groupPinned"/);
  assert.match(projectArchiveSource, /projects: "project\.groupProjects"/);
  assert.match(projectArchiveSource, /archived: "project\.groupArchived"/);
  assert.match(projectsIndexSource, /projects-group-count/);
  assert.match(projectsPageSource, /projects-empty/);

  assert.equal(projectsPageSource.match(/projects-workbench/g)?.length, 1);
  assert.match(projectsPageSource, /<ProjectDetailPanel/);
  assert.match(projectsIndexSource, /projects-inspector/);
  assert.doesNotMatch(projectsPartialSource, /grid-template-columns/);
  assert.match(projectsIndexSource, /aria-labelledby=\{`projects-group-\$\{group\.id\}`\}/);
  assert.match(projectsIndexSource, /<h3 className="projects-group-label"/);
  assert.match(projectsIndexSource, /className="projects-group-rows" role="list"/);
  assert.doesNotMatch(archiveUiSource, /projects-group-head" role="presentation"/);
  assert.doesNotMatch(archiveUiSource, /projects-expand/);
  assert.match(projectsIndexSource, /onDoubleClick=\{\(\) => onActivate\(project\.path\)\}/);
  assert.match(projectsPageSource, /onActivate=\{\(path\) => void activate\(path\)\}/);
});

test("the index row carries identity and the selected row is its own card header", () => {
  // Identity reads left to right: glyph, name, then the path that tells two
  // same-named projects apart without selecting either of them.
  assert.match(projectsIndexSource, /projects-glyph/);
  assert.match(projectsIndexSource, /projects-name-text/);
  assert.match(projectsIndexSource, /projects-name-path/);
  assert.match(projectsIndexSource, /shortenPath\(project\.path\)/);
  // Detail reads right to left, capped by a disclosure indicator that turns
  // down once the row owns an open card.
  assert.match(projectsIndexSource, /projects-row-meta/);
  assert.match(projectsIndexSource, /projects-row-disclosure/);
  assert.match(
    projectsPartialSource,
    /\.projects-row-block\.open \.projects-row-disclosure\s*\{[^}]*rotate\(90deg\)/,
  );
  // The open card is headed by that same row, so the detail never repeats the
  // name, the path, or the status tag: no second source of truth on screen.
  assert.match(projectsDetailSource, /projects-detail-bar/);
  assert.match(projectsDetailSource, /projects-detail-roots/);
  assert.match(projectsDetailSource, /project\.foldersLabel/);
  assert.doesNotMatch(projectsDetailSource, /projects-name-text/);
  assert.doesNotMatch(projectsDetailSource, /projects-name-path/);
  assert.doesNotMatch(projectsDetailSource, /projects-tag/);
});

test("the selected row's card can be closed again", () => {
  // One click resolves through the shared toggle, so clicking the open row
  // closes it instead of re-selecting it and leaving the card up. The open card
  // is the only state the index knows, so nothing is highlighted by default.
  assert.match(projectsPageSource, /nextArchiveOpenPath\(current, path\)/);
  assert.match(projectArchiveSource, /export function nextArchiveOpenPath\(/);
  assert.match(
    projectsPageSource,
    /const \[openPath, setOpenPath\] = useState<string \| null>\(null\)/,
  );
  assert.match(projectsIndexSource, /const open = openPath === project\.path/);
  assert.match(projectsIndexSource, /aria-expanded=\{open\}/);
  assert.match(projectsIndexSource, /\{open && detail \? \(/);
  assert.match(projectsPageSource, /openPath=\{openPath\}/);
  // Moving with the keyboard opens the row it landed on.
  assert.match(projectsPageSource, /setOpenPath\(next\);/);
});

test("the selected row is selected by one shared status helper", () => {
  assert.match(projectArchiveSource, /export function projectStatus\(/);
  assert.match(projectArchiveSource, /active: "project\.active"/);
  assert.match(projectArchiveSource, /open: "project\.openTag"/);
  assert.match(projectArchiveSource, /archived: "project\.archivedTag"/);
  assert.match(projectsIndexSource, /projectStatus\(\{/);
  // The component no longer owns a second copy of the row-state ladder.
  assert.doesNotMatch(projectsIndexSource, /function rowStatus\(/);
});

test("keyboard selection follows the rendered order and yields to the open card", () => {
  // The arrow keys must walk what the user sees: section order with the active
  // sort applied, not the order the index was built in.
  assert.match(projectsPageSource, /groups\.flatMap\(\(group\) => group\.rows\)/);
  assert.match(projectsPageSource, /neighborPath\(\s*\n?\s*renderedRows,/);
  // Enter inside the detail is that control's own action, never "activate".
  assert.match(projectsPageSource, /closest\("\.projects-inspector"\)/);
  // Row ids are encoded, so two paths that differ only in separators cannot
  // collide and send focus to the wrong row.
  assert.match(projectsIndexSource, /projects-row-\$\{encodeURIComponent\(path\)\}/);
});

test("pinned projects use a distinct star glyph", () => {
  assert.match(projectsIndexSource, /IconStar/);
  assert.match(
    projectsIndexSource,
    /projects-glyph[^]*project\.pinned \? \([\s\S]*<IconStar size=\{15\} fill="currentColor" aria-hidden \/>[\s\S]*<IconFolder size=\{15\} aria-hidden \/>/,
  );
});

test("project archive row menu closes on escape and outside press", () => {
  assert.match(projectsPageSource, /<AnchoredMenu/);
  assert.match(projectsPageSource, /onClose=\{\(\) => setMenuFor\(null\)\}/);
  assert.match(projectsPageSource, /menuClassName="projects-menu"/);
  assert.match(projectsPageSource, /role="menu"/);
});

test("project archive styles group archived rows instead of hiding them", () => {
  // The old description line and its page wrapper are gone, not hidden.
  assert.doesNotMatch(projectsPartialSource, /projects-intro/);
  assert.doesNotMatch(projectsPartialSource, /settings-project-archive/);
  assert.match(projectsStyleSource, /\.projects-sort-btn\.active\s*\{/);
  assert.match(projectsStyleSource, /\.projects-group-head\s*\{/);
  assert.match(projectsPartialSource, /\.projects-workbench\s*\{/);
  assert.match(projectsPartialSource, /\.projects-inspector\s*\{/);
  assert.doesNotMatch(projectsStyleSource, /\.projects-row-block\.archived\s*\{\s*display:\s*none/);
  assert.doesNotMatch(projectsStyleSource, /\.projects-row-block\.archived\s*\{\s*opacity/);

  assert.doesNotMatch(projectsPartialSource, /projects-hero/);
  assert.doesNotMatch(projectsPartialSource, /projects-stat/);
  assert.doesNotMatch(projectsPartialSource, /linear-gradient/);
});

test("the project archive honors reduced motion for every animated transition", () => {
  const reduced = projectsPartialSource.slice(
    projectsPartialSource.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  assert.match(reduced, /\.projects-row-block,/);
  assert.match(reduced, /\.projects-row-disclosure,/);
  assert.match(reduced, /\.projects-inspector,/);
  // The expanded card must not slide in for a user who asked for stillness.
  assert.match(reduced, /\.projects-inspector,\s*\.projects-menu\.is-open\s*\{\s*animation:\s*none;/);
});
