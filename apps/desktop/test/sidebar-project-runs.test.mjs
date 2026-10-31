import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  projectRunSummaryIsLive,
  resolveSidebarRunningAffordances,
  summarizeProjectRuns,
  totalRunningProjects,
} = await import("../src/lib/sidebar-project-runs.ts");

const sessions = (...ids) => ids.map((id) => ({ id }));

test("counts running and permission-blocked sessions separately", () => {
  const summary = summarizeProjectRuns(
    sessions("a", "b", "c", "d"),
    { a: true, b: true, d: true },
    { c: [{}] },
  );
  // `d` runs but its permission list is absent, so it is not a wait.
  assert.deepEqual(summary, { running: 3, waiting: 1, total: 4 });
});

test("a session waiting for permission is not also counted as running", () => {
  // The store can hold both flags; the row shows the permission dot, so the
  // group must not double-count the same session.
  const summary = summarizeProjectRuns(sessions("a"), { a: true }, { a: [{}] });
  assert.deepEqual(summary, { running: 0, waiting: 1, total: 1 });
});

test("an empty project is not live", () => {
  const summary = summarizeProjectRuns([], {}, {});
  assert.deepEqual(summary, { running: 0, waiting: 0, total: 0 });
  assert.equal(projectRunSummaryIsLive(summary), false);
});

test("totalRunningProjects counts groups with live work, not sessions", () => {
  const running = summarizeProjectRuns(sessions("a", "b"), { a: true, b: true }, {});
  const waiting = summarizeProjectRuns(sessions("c"), {}, { c: [{}] });
  const idle = summarizeProjectRuns(sessions("d"), {}, {});
  assert.equal(totalRunningProjects([running, waiting, idle]), 2);
});

test("affordances default off so a fresh install shows a clean sidebar", () => {
  assert.deepEqual(resolveSidebarRunningAffordances(undefined), {
    badge: false,
    rail: false,
  });
  assert.deepEqual(resolveSidebarRunningAffordances({}), { badge: false, rail: false });
  assert.deepEqual(resolveSidebarRunningAffordances(null), { badge: false, rail: false });
});

test("the master switch gates both sub-switches", () => {
  // Sub-switches left on, master off: everything is off.
  assert.deepEqual(
    resolveSidebarRunningAffordances({
      sidebarRunningIndicators: false,
      sidebarRunningBadge: true,
      sidebarRunningRail: true,
    }),
    { badge: false, rail: false },
  );
  // Master off by absence (default), sub-switches on: still off.
  assert.deepEqual(
    resolveSidebarRunningAffordances({
      sidebarRunningBadge: true,
      sidebarRunningRail: true,
    }),
    { badge: false, rail: false },
  );
});

test("each sub-switch turns off independently while the master stays on", () => {
  assert.deepEqual(
    resolveSidebarRunningAffordances({
      sidebarRunningIndicators: true,
      sidebarRunningBadge: false,
      sidebarRunningRail: true,
    }),
    { badge: false, rail: true },
  );
  assert.deepEqual(
    resolveSidebarRunningAffordances({
      sidebarRunningIndicators: true,
      sidebarRunningBadge: true,
      sidebarRunningRail: false,
    }),
    { badge: true, rail: false },
  );
});

test("the sidebar renders both affordances from the resolved switches", async () => {
  const sidebar = await readFile(
    new URL("../src/components/Sidebar.tsx", import.meta.url),
    "utf8",
  );
  // The header, not the session rows, owns the affordances: the collapsed
  // group body is `inert`, so a row-level marker disappears exactly when the
  // answer matters. Guard the wiring that keeps them on the header.
  assert.match(
    sidebar,
    /const runningAffordances = resolveSidebarRunningAffordances\(settings\)/,
  );
  assert.match(sidebar, /const runSummary = summarizeProjectRuns\(/);
  assert.match(sidebar, /showRunBadge \? <ProjectRunBadge summary=\{runSummary\} \/>/);
  assert.match(sidebar, /showRunRail \? <ProjectRunRail summary=\{runSummary\} \/>/);
  assert.match(sidebar, /\{entry\.name\}<\/span>[\s\S]{0,220}ProjectRunBadge/);
});

test("remote project groups carry the same affordances", async () => {
  const remote = await readFile(
    new URL("../src/components/remote/RemoteProjectGroups.tsx", import.meta.url),
    "utf8",
  );
  assert.match(remote, /summarizeProjectRuns\(sessions, runningSessions, pendingPermissions\)/);
  assert.match(remote, /showRunRail \? <ProjectRunRail summary=\{runSummary\} \/>/);
  assert.match(remote, /showRunBadge \? <ProjectRunBadge summary=\{runSummary\} \/>/);
});

test("both affordance colours resolve through theme tokens", async () => {
  const css = await readFile(
    new URL("../src/styles/sidebar-threads.css", import.meta.url),
    "utf8",
  );
  const block = css.slice(css.indexOf(".project-run-badges"));
  assert.ok(block.length > 0, "the affordance stylesheet block must exist");
  // A literal colour here would be pinned out of every contributed theme.
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(block, /\b(?:rgb|hsl)a?\(/);
  assert.doesNotMatch(block, /var\(--(?:gray|accent|color)-/);
  assert.match(block, /--ds-warning/);
  assert.match(block, /--ds-purple/);
  // Motion is decoration only: it must be dropped under reduced motion.
  assert.match(block, /@media \(prefers-reduced-motion: reduce\)/);
});
