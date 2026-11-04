/**
 * Contract tests for the Artifacts page.
 *
 * `artifacts.list` has existed in host-core since 04-data-storage §4.9 and had
 * no renderer surface, so these tests pin the wiring rather than the visuals: a
 * new page has to be reachable from three places (shell route, sidebar, global
 * search), the IPC hop has to narrow what it forwards, and the list must stay a
 * read-only view of a host-owned table.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const pageSource = await read("../src/pages/ArtifactsPage.tsx");
const hookSource = await read("../src/features/artifacts/use-artifacts.ts");
const styles = await read("../src/features/artifacts/artifacts.css");
const shellSource = await read("../src/features/app/AppShell.tsx");
const runtimeSource = await read("../src/features/app/useAppShellRuntime.tsx");
const stateSource = await read("../src/stores/app-state.ts");
const sidebarSource = await read("../src/components/Sidebar.tsx");
const searchSource = await read("../src/components/SearchDialog.tsx");
const apiSource = await read("../src/lib/api.ts");
const ipcSource = await read("../electron/main/ipc/artifacts-ipc.ts");
const registerSource = await read("../electron/main/ipc/register.ts");
const hostSource = await read("../../../crates/host-core/src/artifacts.rs");

test("the artifacts page is reachable from the shell, the sidebar and global search", () => {
  // Shell: lazy route, so the page is not in the first chunk.
  assert.match(shellSource, /const ArtifactsPage = lazy\(\(\) =>\n  import\("\.\.\/\.\.\/pages\/ArtifactsPage"\)/);
  assert.match(shellSource, /page === "artifacts" \? \(/);
  // The page type has to carry the id, or the route cannot be typed.
  assert.match(
    stateSource,
    /page: "chat" \| "scheduled" \| "plugins" \| "artifacts" \| "tools" \| "settings"/,
  );
  // A full page hides the work panel and must not be treated as a chat surface.
  assert.match(
    runtimeSource,
    /page === "settings" \|\|\s*page === "plugins" \|\|\s*page === "scheduled" \|\|\s*page === "artifacts" \|\|\s*page === "tools"/,
  );
  assert.match(
    runtimeSource,
    /p !== "settings" &&\s*p !== "plugins" &&\s*p !== "scheduled" &&\s*p !== "artifacts" &&\s*p !== "tools"/,
  );
  // The sidebar entry is a destination row above the session list, not a footer
  // chip: a place to go reads as a row where a conversation list starts.
  assert.match(sidebarSource, /<nav className="sidebar-nav-rows" aria-label=\{t\("nav\.pages"\)\}>/);
  assert.match(sidebarSource, /className=\{`sidebar-nav-row\$\{page === "artifacts" \? " is-active" : ""\}`\}/);
  assert.match(sidebarSource, /data-nav="artifacts"/);
  assert.match(sidebarSource, /setPage\("artifacts"\)/);
  const navAt = sidebarSource.indexOf('className="sidebar-nav-rows"');
  const listAt = sidebarSource.indexOf('className="sidebar-standalone-sessions"');
  assert.ok(navAt > 0 && listAt > 0 && navAt < listAt, "the entry must precede the session list");
  // The footer keeps its three actions.
  assert.doesNotMatch(sidebarSource, /footer-action \$\{page === "artifacts"/);
  // Global search lists it next to the other navigable pages.
  assert.match(searchSource, /\{ page: "artifacts", labelKey: "artifacts\.title", icon: IconFileText \}/);
});

test("the renderer asks the host through one narrowed IPC hop", () => {
  // Renderer never reaches host-core directly.
  assert.match(apiSource, /listArtifacts: \(filter\?: ArtifactListFilter\) =>/);
  assert.match(apiSource, /IPC\.invoke\.artifactsList/);
  // Main narrows the payload before forwarding.
  assert.match(ipcSource, /host\.call\("artifacts\.list", listParams\(input\)\)/);
  assert.match(ipcSource, /if \(sessionId\) params\.sessionId = sessionId;/);
  assert.match(ipcSource, /Math\.min\(limit, MAX_LIMIT\)/);
  assert.doesNotMatch(ipcSource, /params\.limit = raw\.limit/);
  assert.match(registerSource, /registerArtifactsIpc\(\{ registrar, getHost \}\)/);
});

test("the page renders host rows and never mutates them", () => {
  // Read-only surface: one host read, no write channels.
  assert.match(hookSource, /api\n?\s*\.listArtifacts\(\{ limit: LOAD_LIMIT \}\)/);
  assert.doesNotMatch(hookSource, /save|update|delete|forget/i);
  // Grouping and filtering are pure helpers from shared, not inline in the view.
  assert.match(hookSource, /groupArtifactsBySession\(filterArtifacts\(rows, query\)\)/);
  assert.match(pageSource, /from "@pi-desktop\/shared"/);
  assert.match(pageSource, /artifactFileName\(row\.path\)/);
  assert.match(pageSource, /artifactDirectory\(row\.path\)/);
  assert.match(pageSource, /artifactOpKey\(row\.op\)/);
  // User-visible strings come from i18n, and the primitives are the shared ones.
  assert.match(pageSource, /t\("artifacts\.title"\)/);
  assert.match(pageSource, /<Input[\s\S]{0,200}className="artifacts-search"/);
  assert.match(pageSource, /<TooltipButton/);
  // The file name is the opener, through the transcript's own resolver rather
  // than a second way of turning a path into a view.
  assert.match(pageSource, /useOpenChatFileRef\(\)/);
  assert.match(pageSource, /onClick=\{onOpen\}/);
  assert.match(pageSource, /className="artifacts-name font-mono"/);
  assert.match(pageSource, /t\("artifacts\.openFile", \{ name: artifactFileName\(row\.path\) \}\)/);
});

test("each session group names its project", () => {
  assert.match(pageSource, /group\.projectName \? \(/);
  assert.match(pageSource, /className="artifacts-group-project" title=\{group\.projectPath \?\? undefined\}/);
  assert.match(styles, /\.artifacts-group-project\s*\{/);
  // The host joins the project, so the renderer never guesses from a path.
  assert.match(hostSource, /LEFT JOIN projects p ON p\.id = s\.project_id/);
  assert.match(hostSource, /project_name: row\.get\(2\)\?/);
});

test("the artifact list is themed through tokens and stays scannable", () => {
  assert.match(styles, /\.artifacts-row\s*\{[\s\S]*?grid-template-columns:/);
  assert.match(styles, /\.artifacts-dir\s*\{[\s\S]*?text-overflow: ellipsis;/);
  assert.match(styles, /\.artifacts-list\s*\{[\s\S]*?background: var\(--ds-tile\);/);
  // No raw type or radius values: only the token scales.
  assert.doesNotMatch(styles, /font-size:\s*\d/);
  assert.doesNotMatch(styles, /border-radius:\s*\d/);
  assert.doesNotMatch(styles, /line-height:\s*\d/);
});
