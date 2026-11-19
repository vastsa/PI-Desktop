import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  EMPTY_WORKBENCH_LAYOUT,
  markWorkbenchLayoutUserChange,
  WORKBENCH_VIEW_PRESENTATION,
  workbenchLayoutTransition,
  workbenchViewActivationKey,
} from "../src/lib/plugin-view-workbench-layout.ts";

/**
 * Host auto-layout for a docked plugin view that declared
 * `presentation: "workbench"` (ADR 0348).
 *
 * The layout itself is shell state, so the policy is extracted and asserted
 * directly: when it applies, what it borrows, what it gives back, and what it
 * must leave alone. The shell wiring is asserted as a source contract because
 * mounting the real AppShell hook would need the whole Electron surface.
 */

const read = (path) => readFileSync(resolve(path), "utf8");
const shellSource = read("src/features/app/useAppShellRuntime.tsx");
const ipcSource = read("electron/main/ipc/plugin-ui-ipc.ts");

const workbenchView = { ref: "demo.novel/workbench", presentation: "workbench" };
const plainView = { ref: "demo.novel/notes" };

const layoutInput = (overrides = {}) => ({
  page: "chat",
  sessionId: "session-a",
  workPanelOpen: true,
  presented: true,
  tabs: [{ id: "plugin:demo.novel/workbench", kind: "plugin", resource: "demo.novel/workbench" }],
  activeTabId: "plugin:demo.novel/workbench",
  views: [workbenchView, plainView],
  ...overrides,
});

/** The host layout a transition is being applied to. */
const host = (maximized = false, sidebarCollapsed = false) => ({
  maximized,
  sidebarCollapsed,
});

test("only a foreground, presented, opted-in view activates the workbench layout", () => {
  const key = workbenchViewActivationKey(layoutInput());
  assert.equal(typeof key, "string");
  assert.equal(WORKBENCH_VIEW_PRESENTATION, "workbench");

  assert.equal(workbenchViewActivationKey(layoutInput({ page: "settings" })), null);
  assert.equal(workbenchViewActivationKey(layoutInput({ workPanelOpen: false })), null);
  assert.equal(workbenchViewActivationKey(layoutInput({ presented: false })), null);
  assert.equal(workbenchViewActivationKey(layoutInput({ sessionId: null })), null);

  // A view without the opt-in keeps the ordinary docked pane.
  assert.equal(
    workbenchViewActivationKey(
      layoutInput({
        tabs: [{ id: "plugin:demo.novel/notes", kind: "plugin", resource: "demo.novel/notes" }],
        activeTabId: "plugin:demo.novel/notes",
      }),
    ),
    null,
  );
  // Tab kinds that cannot carry a view, and a view the host no longer lists.
  assert.equal(
    workbenchViewActivationKey(
      layoutInput({
        tabs: [{ id: "plugin:demo.novel/workbench", kind: "file", resource: "demo.novel/workbench" }],
      }),
    ),
    null,
  );
  assert.equal(
    workbenchViewActivationKey(layoutInput({ views: [plainView] })),
    null,
  );
  // A background session's tab is not the foreground tab.
  assert.equal(
    workbenchViewActivationKey(layoutInput({ activeTabId: "plugin:demo.novel/notes", tabs: [
      { id: "plugin:demo.novel/workbench", kind: "plugin", resource: "demo.novel/workbench" },
      { id: "plugin:demo.novel/notes", kind: "plugin", resource: "demo.novel/notes" },
    ] })),
    null,
  );
});

test("opening the view maximizes the panel and collapses the sidebar", () => {
  const key = workbenchViewActivationKey(layoutInput());
  const command = workbenchLayoutTransition(EMPTY_WORKBENCH_LAYOUT, { key, ...host() });

  assert.equal(command.setMaximized, true);
  assert.equal(command.setSidebarCollapsed, true);
  assert.deepEqual(command.state, { key, maximized: true, sidebarCollapsed: true });
});

test("a repeated render of the same view issues no command", () => {
  const key = workbenchViewActivationKey(layoutInput());
  const entered = workbenchLayoutTransition(EMPTY_WORKBENCH_LAYOUT, { key, ...host() });
  // The user restored nothing; a plain re-render with the same activation must
  // not re-apply or restore.
  const again = workbenchLayoutTransition(entered.state, { key, ...host(true, true) });
  assert.equal(again.state, entered.state);
  assert.equal(again.setMaximized, undefined);
  assert.equal(again.setSidebarCollapsed, undefined);
});

test("leaving the view restores the layout it borrowed", () => {
  const key = workbenchViewActivationKey(layoutInput());
  const entered = workbenchLayoutTransition(EMPTY_WORKBENCH_LAYOUT, { key, ...host() });
  const left = workbenchLayoutTransition(entered.state, { key: null, ...host(true, true) });

  assert.equal(left.setMaximized, false);
  assert.equal(left.setSidebarCollapsed, false);
  assert.deepEqual(left.state, EMPTY_WORKBENCH_LAYOUT);
});

test("a manual maximize or manual collapse is never taken back", () => {
  const key = workbenchViewActivationKey(layoutInput());
  // The user had already maximized and collapsed before opening the view.
  const entered = workbenchLayoutTransition(EMPTY_WORKBENCH_LAYOUT, {
    key,
    ...host(true, true),
  });
  assert.equal(entered.setMaximized, undefined);
  assert.equal(entered.setSidebarCollapsed, undefined);

  const left = workbenchLayoutTransition(entered.state, { key: null, ...host(true, true) });
  assert.equal(left.setMaximized, undefined);
  assert.equal(left.setSidebarCollapsed, undefined);
  assert.equal(left.state.maximized, false);
  assert.equal(left.state.sidebarCollapsed, false);
});

test("a manual restore inside the view stays restored", () => {
  const key = workbenchViewActivationKey(layoutInput());
  const entered = workbenchLayoutTransition(EMPTY_WORKBENCH_LAYOUT, { key, ...host() });

  // The user collapses the panel (restore) and reopens the sidebar.
  let state = markWorkbenchLayoutUserChange(entered.state, "maximized");
  state = markWorkbenchLayoutUserChange(state, "sidebarCollapsed");
  assert.equal(state.key, key);
  assert.equal(state.maximized, false);
  assert.equal(state.sidebarCollapsed, false);

  const left = workbenchLayoutTransition(state, { key: null, ...host(false, false) });
  assert.equal(left.setMaximized, undefined);
  assert.equal(left.setSidebarCollapsed, undefined);
  assert.deepEqual(left.state, EMPTY_WORKBENCH_LAYOUT);
});

test("switching directly between workbench views keeps the borrowed layout", () => {
  const first = workbenchViewActivationKey(layoutInput());
  const entered = workbenchLayoutTransition(EMPTY_WORKBENCH_LAYOUT, { key: first, ...host() });

  const second = workbenchViewActivationKey(
    layoutInput({
      tabs: [
        { id: "plugin:demo.novel/workbench", kind: "plugin", resource: "demo.novel/workbench" },
        { id: "plugin:demo.apple/draft", kind: "plugin", resource: "demo.apple/draft" },
      ],
      activeTabId: "plugin:demo.apple/draft",
      views: [workbenchView, { ref: "demo.apple/draft", presentation: "workbench" }],
    }),
  );
  assert.notEqual(second, first);

  const switched = workbenchLayoutTransition(entered.state, { key: second, ...host(true, true) });
  assert.equal(switched.setMaximized, undefined);
  assert.equal(switched.setSidebarCollapsed, undefined);
  assert.equal(switched.state.key, second);
  assert.equal(switched.state.maximized, true);
  assert.equal(switched.state.sidebarCollapsed, true);

  // Leaving after a direct switch still restores the first activation's layout.
  const left = workbenchLayoutTransition(switched.state, { key: null, ...host(true, true) });
  assert.equal(left.setMaximized, false);
  assert.equal(left.setSidebarCollapsed, false);
});

test("a session switch between workbench views is also a direct switch", () => {
  const first = workbenchViewActivationKey(layoutInput());
  const entered = workbenchLayoutTransition(EMPTY_WORKBENCH_LAYOUT, { key: first, ...host() });
  const otherSession = workbenchViewActivationKey(layoutInput({ sessionId: "session-b" }));

  assert.notEqual(otherSession, first);
  const switched = workbenchLayoutTransition(entered.state, { key: otherSession, ...host(true, true) });
  assert.equal(switched.setMaximized, undefined);
  assert.equal(switched.setSidebarCollapsed, undefined);
  assert.equal(switched.state.key, otherSession);
});

test("a tab switch to a non-workbench tab restores, then re-applies on return", () => {
  const key = workbenchViewActivationKey(layoutInput());
  const entered = workbenchLayoutTransition(EMPTY_WORKBENCH_LAYOUT, { key, ...host() });

  const left = workbenchLayoutTransition(entered.state, { key: null, ...host(true, true) });
  assert.equal(left.setMaximized, false);
  assert.equal(left.setSidebarCollapsed, false);

  const back = workbenchLayoutTransition(left.state, { key, ...host(false, false) });
  assert.equal(back.setMaximized, true);
  assert.equal(back.setSidebarCollapsed, true);
});

test("clearing an axis the policy never owned is a no-op", () => {
  const key = workbenchViewActivationKey(layoutInput());
  const state = { key, maximized: false, sidebarCollapsed: false };
  assert.equal(markWorkbenchLayoutUserChange(state, "maximized"), state);
  assert.equal(markWorkbenchLayoutUserChange(state, "sidebarCollapsed"), state);
});

test("the shell wires the policy and the host forwards the opt-in", () => {
  // Renderer: the activation transition runs once per activation change and the
  // manual controls take their axis back instead of fighting the policy.
  assert.match(shellSource, /useMemo\(\s*\(\) =>\s*workbenchViewActivationKey\(/);
  assert.match(shellSource, /workbenchLayoutTransition\(workbenchLayoutRef\.current/);
  assert.match(
    shellSource,
    /toggleWorkPanelMaximize[\s\S]{0,400}markWorkbenchLayoutUserChange\([\s\S]{0,120}"maximized"/,
  );
  assert.match(
    shellSource,
    /const reopenSidebar[\s\S]{0,1600}markWorkbenchLayoutUserChange\([\s\S]{0,120}"sidebarCollapsed"/,
  );
  // The transition must run on activation changes only, never on every render.
  assert.match(shellSource, /\}, \[workbenchViewKey\]\);/);

  // Electron host: the manifest field reaches the renderer only when declared,
  // so an ordinary view keeps the previous payload shape.
  assert.match(
    ipcSource,
    /view\.presentation === "workbench"[\s\S]{0,120}\{ presentation: "workbench" as const \}/,
  );
});
