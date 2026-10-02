/**
 * A session reference the host marked gone, and a hover-card click on a session
 * that disappeared in the meantime, must fail visibly instead of opening an
 * empty chat. The availability decision is asserted behaviourally; the JSX and
 * the Sidebar handler are asserted against source, matching the local
 * convention in sidebar-navigation.test.mjs (these modules need a DOM to run).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sessionReferenceAvailable } from "../src/features/sessions/session-collaboration-view.ts";

const hoverSource = await readFile(
  new URL("../src/features/sessions/SessionHoverCard.tsx", import.meta.url),
  "utf8",
);
const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);

const hoverHandler = sidebarSource.match(
  /const openSessionFromHover = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/,
)?.[0] ?? "";

/** The opening tag that owns an attribute occurrence. */
function openingTag(source, index) {
  return {
    tag: source.slice(source.lastIndexOf("<", index), source.indexOf(">", index) + 1),
    end: source.indexOf(">", index) + 1,
  };
}

test("only a reference the host marked gone becomes non-interactive", () => {
  assert.equal(sessionReferenceAvailable({ sessionId: "worker", title: "Worker" }), true, "a host without the field stays navigable");
  assert.equal(sessionReferenceAvailable({ sessionId: "worker", title: "Worker", available: true }), true);
  assert.equal(sessionReferenceAvailable({ sessionId: "worker", title: "Worker", available: false }), false);
  assert.equal(sessionReferenceAvailable({ sessionId: "worker", title: "Worker", available: undefined }), true);
});

test("an unavailable reference keeps its identity as plain non-interactive text", () => {
  const occurrences = [...hoverSource.matchAll(/data-session-link-unavailable="true"/g)];
  assert.equal(occurrences.length, 2, "createdBySession and createdSessions both degrade");

  for (const occurrence of occurrences) {
    const { tag, end } = openingTag(hoverSource, occurrence.index);
    assert.match(tag, /^<span\s/, "an unavailable reference is not a button");
    assert.doesNotMatch(tag, /onClick/, "an unavailable reference has no click handler");
    assert.doesNotMatch(tag, /type="button"/, "an unavailable reference is not a button");
    assert.match(tag, /sidebar-session-hover-card-session-link-unavailable/);
    assert.match(tag, /data-session-link=\{/, "tests can still find the reference by id");
    assert.match(tag, /title=\{t\("sessionCollaboration\.referenceUnavailable"\)\}/);
    const body = hoverSource.slice(end, end + 400);
    assert.match(body, /className="sr-only">\{t\("sessionCollaboration\.referenceUnavailable"\)\}<\/span>/, "the reason is part of the accessible text");
  }
});

test("available references keep their button and their id attributes", () => {
  assert.match(hoverSource, /data-session-link=\{summary\.createdBySession\.sessionId\}/);
  assert.match(hoverSource, /data-session-link=\{reference\.sessionId\}/);
  assert.match(hoverSource, /type="button"/);
  assert.match(hoverSource, /onClick=\{\(\) => openSessionReference\(reference\)\}/);
  assert.match(hoverSource, /onClick=\{\(\) => openSessionReference\(summary\.createdBySession!\)\}/);
});

test("peer exchanges stay plain text instead of becoming links", () => {
  const exchanges = hoverSource.match(
    /sidebar-session-hover-card-exchanges[\s\S]*?<\/ol>/,
  )?.[0] ?? "";
  assert.match(exchanges, /exchange\.peer\.title \|\| exchange\.peer\.sessionId/);
  assert.doesNotMatch(exchanges, /data-session-link/);
  assert.doesNotMatch(exchanges, /<button/);
});

test("the hover card polls only while it is connected, visible and focused", () => {
  assert.match(
    hoverSource,
    /isVisible: \(\) => target\.isConnected && !document\.hidden && document\.hasFocus\(\)/,
  );
});

test("hover-card navigation refuses to select a session that no longer exists", () => {
  assert.ok(hoverHandler.length > 0, "the hover navigation handler must exist");
  assert.match(hoverHandler, /useAppStore\.getState\(\)\.sessions\.some\(/);
  // Only presence is read from this reply, so the read must stay bounded: an
  // uncapped detail read moves every message of the session over IPC to
  // answer one boolean.
  assert.match(
    hoverHandler,
    /const detail = await api\.getSession\(sessionId, \{ messageLimit: 1 \}\)/,
  );
  assert.match(hoverHandler, /if \(!detail\.session\) \{/);
  assert.match(hoverHandler, /reportError\(new Error\(t\("sessionCollaboration\.sessionMissing"\)\)\)/);
  assert.match(hoverHandler, /await selectSession\(sessionId\)/);
  assert.match(hoverHandler, /focusComposer\(\)/);
  assert.match(hoverHandler, /catch \(error\) \{\s*reportError\(error\);/);
  assert.ok(
    hoverHandler.indexOf("sessionMissing") < hoverHandler.indexOf("await selectSession(sessionId)"),
    "the missing-session report must happen before any selection",
  );
  assert.doesNotMatch(hoverHandler, /as any|@ts-ignore|@ts-nocheck/);
});
