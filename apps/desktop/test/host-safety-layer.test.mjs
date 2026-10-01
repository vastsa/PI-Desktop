import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * When plugin layers (`pi.ui.openLayer`) step aside: while the visible
 * session waits on the user's own decision, or while a host decision surface
 * outside the store (an extension prompt) is up.
 */
const { sessionAwaitsDecision, claimHostSafetySurface, isHostSafetySurfaceMounted, subscribeHostSafetySurfaces } =
  await import("../src/lib/host-safety-layer.ts");

const idle = { activeSessionId: "s1", pendingPermissions: {}, pendingAsks: {}, planCheckpoints: {} };

test("the visible session awaits a decision on a permission, a question or a pending plan", () => {
  assert.equal(sessionAwaitsDecision(idle), false);
  assert.equal(sessionAwaitsDecision({ ...idle, pendingPermissions: { s1: [{ requestId: "p" }] } }), true);
  assert.equal(sessionAwaitsDecision({ ...idle, pendingAsks: { s1: [{ requestId: "a" }] } }), true);
  assert.equal(sessionAwaitsDecision({ ...idle, planCheckpoints: { s1: { status: "pending" } } }), true);
});

test("settled plans, other sessions' requests and no session at all await nothing", () => {
  assert.equal(sessionAwaitsDecision({ ...idle, planCheckpoints: { s1: { status: "approved" } } }), false);
  assert.equal(sessionAwaitsDecision({ ...idle, pendingPermissions: { s2: [{ requestId: "p" }] } }), false);
  assert.equal(sessionAwaitsDecision({ ...idle, pendingAsks: { s2: [{ requestId: "a" }] } }), false);
  assert.equal(
    sessionAwaitsDecision({ ...idle, activeSessionId: undefined, pendingPermissions: { s1: [{ requestId: "p" }] } }),
    false,
  );
});

test("host surfaces are counted by owner, so one closing cannot clear another", () => {
  let notified = 0;
  const unsubscribe = subscribeHostSafetySurfaces(() => notified++);
  assert.equal(isHostSafetySurfaceMounted(), false);
  const first = claimHostSafetySurface();
  const second = claimHostSafetySurface();
  assert.equal(isHostSafetySurfaceMounted(), true);
  first();
  first();
  assert.equal(isHostSafetySurfaceMounted(), true, "the other surface is still up");
  second();
  assert.equal(isHostSafetySurfaceMounted(), false);
  assert.equal(notified, 4, "a repeated release does not notify");
  unsubscribe();
  claimHostSafetySurface()();
  assert.equal(notified, 4);
});

test("an extension prompt holds the plugin layers aside while it is up", async () => {
  // The permission, question and plan surfaces are store state, read by
  // `sessionAwaitsDecision`; the extension prompt queue is the host's own.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/components/ExtensionPromptDialog.tsx", import.meta.url), "utf8");
  const dialog = source.slice(source.indexOf("function ExtensionPromptDialog("));
  assert.match(dialog, /\n  useHostSafetySurface\(\);\n/);
});
