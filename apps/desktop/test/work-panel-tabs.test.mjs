import assert from "node:assert/strict";
import test from "node:test";

const {
  activateWorkPanelTabState,
  browserPluginTab,
  closeWorkPanelTabState,
  emptyWorkPanelContext,
  fileWorkPanelTab,
  isKnownWorkPanelTab,
  isToolWorkPanelTab,
  normalizeWorkPanelFilePath,
  openWorkPanelTabState,
  pluginWorkPanelTab,
  sanitizeWorkPanelTabsState,
  shouldOpenReviewArtifact,
  switchWorkPanelContextState,
  toolWorkPanelTab,
} = await import("../src/lib/work-panel-tabs.ts");

test("work panel tabs open on demand and deduplicate by resource", () => {
  const empty = { tabs: [], activeTabId: null };
  const review = openWorkPanelTabState(empty, toolWorkPanelTab("review"));
  const file = openWorkPanelTabState(review, fileWorkPanelTab("src/App.tsx"));
  const reopened = openWorkPanelTabState(file, toolWorkPanelTab("review"));

  assert.deepEqual(reopened.tabs.map((tab) => tab.id), ["review", "file:src/App.tsx"]);
  assert.equal(reopened.activeTabId, "review");
});

test("file tabs normalize lexical paths and remain distinct by resource", () => {
  const first = fileWorkPanelTab("src\\App.tsx");
  const equivalent = fileWorkPanelTab("./src//components/../App.tsx");
  const second = fileWorkPanelTab("test/App.tsx");

  assert.equal(first.id, "file:src/App.tsx");
  assert.equal(equivalent.id, first.id);
  assert.notEqual(first.id, second.id);
  assert.equal(normalizeWorkPanelFilePath("../src/../App.tsx"), "../App.tsx");
  assert.equal(normalizeWorkPanelFilePath("/repo/./src/../App.tsx"), "/repo/App.tsx");
});

test("closing the active tab selects its right neighbor then its left", () => {
  const state = {
    tabs: [
      toolWorkPanelTab("review"),
      fileWorkPanelTab("src/App.tsx"),
      browserPluginTab(),
    ],
    activeTabId: "file:src/App.tsx",
  };
  const middleClosed = closeWorkPanelTabState(state, "file:src/App.tsx");
  const endClosed = closeWorkPanelTabState(middleClosed, browserPluginTab().id);

  assert.equal(middleClosed.activeTabId, browserPluginTab().id);
  assert.equal(endClosed.activeTabId, "review");
});

test("closing an inactive tab preserves selection and the last close empties state", () => {
  const state = {
    tabs: [toolWorkPanelTab("review"), browserPluginTab()],
    activeTabId: "review",
  };
  const inactiveClosed = closeWorkPanelTabState(state, browserPluginTab().id);
  const empty = closeWorkPanelTabState(inactiveClosed, "review");

  assert.equal(inactiveClosed.activeTabId, "review");
  assert.deepEqual(empty, { tabs: [], activeTabId: null });
});

test("activation ignores stale tab ids", () => {
  const state = { tabs: [toolWorkPanelTab("review")], activeTabId: "review" };
  assert.equal(activateWorkPanelTabState(state, "missing"), state);
});

test("unknown retained tabs are discarded without losing a known selection", () => {
  const stale = { id: "removed", kind: "removed" };
  const selected = sanitizeWorkPanelTabsState({
    tabs: [stale, browserPluginTab(), toolWorkPanelTab("review")],
    activeTabId: browserPluginTab().id,
  });
  const staleSelected = sanitizeWorkPanelTabsState({
    tabs: [browserPluginTab(), stale, toolWorkPanelTab("review")],
    activeTabId: "removed",
  });

  assert.equal(isKnownWorkPanelTab(stale), false);
  assert.deepEqual(selected.tabs.map((tab) => tab.id), [
    browserPluginTab().id,
    "review",
  ]);
  assert.equal(selected.activeTabId, browserPluginTab().id);
  assert.equal(staleSelected.activeTabId, "review");
});

test("only plugin views are launchable tools", () => {
  assert.equal(isToolWorkPanelTab(browserPluginTab()), true);
  assert.equal(isToolWorkPanelTab(toolWorkPanelTab("review")), false);
  assert.equal(isToolWorkPanelTab(fileWorkPanelTab("README.md")), false);
  assert.equal(isToolWorkPanelTab(pluginWorkPanelTab("pi.files", "files")), true);
  assert.equal(isKnownWorkPanelTab({ id: "browser", kind: "browser" }), false);
});

test("review artifacts are recognized independently of the visible session", () => {
  const base = {
    toolName: "Write",
    isError: false,
    result: { details: { root: "workspace" } },
  };

  assert.equal(shouldOpenReviewArtifact(base), true);
  assert.equal(shouldOpenReviewArtifact({ ...base, toolName: "Edit" }), true);
  assert.equal(shouldOpenReviewArtifact({ ...base, toolName: "Bash" }), false);
  assert.equal(shouldOpenReviewArtifact({ ...base, isError: true }), false);
  assert.equal(
    shouldOpenReviewArtifact({
      ...base,
      result: { details: { root: "scratch" } },
    }),
    false,
  );
});

test("empty work panel context has no visible or retained resource state", () => {
  assert.deepEqual(emptyWorkPanelContext(), {
    open: false,
    tabs: [],
    activeTabId: null,
    fileRequest: null,
  });
});

test("switching work panel contexts isolates session tabs and visible state", () => {
  const sessionA = {
    open: true,
    tabs: [browserPluginTab(), fileWorkPanelTab("src/App.tsx")],
    activeTabId: "file:src/App.tsx",
    fileRequest: { path: "src/App.tsx", seq: 4 },
  };
  const sessionB = {
    open: false,
    tabs: [browserPluginTab()],
    activeTabId: browserPluginTab().id,
    fileRequest: null,
  };

  const toB = switchWorkPanelContextState(
    { "session-b": sessionB },
    "session-a",
    sessionA,
    "session-b",
  );
  assert.deepEqual(toB.contexts["session-a"], sessionA);
  assert.deepEqual(toB.visible, sessionB);

  const backToA = switchWorkPanelContextState(
    toB.contexts,
    "session-b",
    toB.visible,
    "session-a",
  );
  assert.deepEqual(backToA.contexts["session-b"], sessionB);
  assert.deepEqual(backToA.visible, sessionA);
  assert.notEqual(backToA.visible.tabs, toB.visible.tabs);
});

test("switching to a session without context returns an isolated empty state", () => {
  const sessionA = {
    open: true,
    tabs: [toolWorkPanelTab("review")],
    activeTabId: "review",
    fileRequest: null,
  };
  const switched = switchWorkPanelContextState(
    {},
    "session-a",
    sessionA,
    "session-new",
  );

  assert.deepEqual(switched.contexts["session-a"], sessionA);
  assert.deepEqual(switched.visible, emptyWorkPanelContext());
  switched.visible.tabs.push(browserPluginTab());
  assert.deepEqual(switched.contexts["session-a"].tabs, sessionA.tabs);
});

test("a newer retained artifact is not overwritten by a stale visible projection", () => {
  const staleVisible = emptyWorkPanelContext();
  const retained = {
    open: true,
    tabs: [toolWorkPanelTab("review")],
    activeTabId: "review",
    fileRequest: null,
  };
  const switched = switchWorkPanelContextState(
    { "session-a": retained },
    "session-a",
    staleVisible,
    "session-b",
  );

  assert.deepEqual(switched.contexts["session-a"], retained);
  assert.deepEqual(switched.visible, emptyWorkPanelContext());
});
