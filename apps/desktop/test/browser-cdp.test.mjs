import { readMainSourceSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const cdpSource = readFileSync(
  resolve("electron/main/browser-cdp.ts"),
  "utf8",
);
const hostSource = readFileSync(
  resolve("electron/main/browser-host.ts"),
  "utf8",
);

function clampGuestBounds(view, hole) {
  const x = Math.max(view.x, view.x + hole.x);
  const y = Math.max(view.y, view.y + hole.y);
  const right = Math.min(view.x + view.width, view.x + hole.x + hole.width);
  const bottom = Math.min(view.y + view.height, view.y + hole.y + hole.height);
  const width = Math.floor(right - x);
  const height = Math.floor(bottom - y);
  if (width < 1 || height < 1) return null;
  return { x: Math.floor(x), y: Math.floor(y), width, height };
}

function flattenAxTree(nodes) {
  const byId = new Map();
  for (const node of nodes) {
    if (typeof node.nodeId === "string") byId.set(node.nodeId, node);
  }
  const childIds = new Set();
  for (const node of nodes) {
    for (const id of node.childIds ?? []) childIds.add(id);
  }
  const roots = nodes.filter(
    (node) => typeof node.nodeId === "string" && !childIds.has(node.nodeId),
  );
  const uids = new Map();
  const lines = [];
  let next = 1;
  const walk = (node, depth) => {
    if (!node.ignored) {
      const role = node.role?.value?.trim() || "Generic";
      const name = node.name?.value?.trim() ?? "";
      const uid = `e${next}`;
      next += 1;
      if (typeof node.backendDOMNodeId === "number") uids.set(uid, node.backendDOMNodeId);
      const label = name ? `${role} ${JSON.stringify(name)}` : role;
      lines.push(`${"  ".repeat(depth)}- ${uid} ${label}`);
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) walk(child, node.ignored ? depth : depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  return { tree: lines.join("\n") || "(empty)", uids };
}

test("CDP allowlist denies cookies, storage, and target methods", () => {
  assert.match(cdpSource, /Page\.captureScreenshot/);
  assert.match(cdpSource, /Accessibility\.getFullAXTree/);
  assert.doesNotMatch(cdpSource, /Network\.getAllCookies/);
  assert.doesNotMatch(cdpSource, /Network\.setCookie/);
  assert.doesNotMatch(cdpSource, /Storage\./);
  assert.doesNotMatch(cdpSource, /"Target\./);
  assert.doesNotMatch(cdpSource, /Fetch\./);
  assert.doesNotMatch(cdpSource, /Page\.navigate/);
  assert.match(cdpSource, /CDP method not allowed/);
});

test("guest bounds are clamped to the plugin view rect", () => {
  assert.match(hostSource, /export function clampGuestBounds/);
  const view = { x: 400, y: 40, width: 360, height: 600 };
  const hole = { x: 0, y: 36, width: 360, height: 564 };
  assert.deepEqual(clampGuestBounds(view, hole), {
    x: 400,
    y: 76,
    width: 360,
    height: 564,
  });
  assert.equal(
    clampGuestBounds(view, { x: -80, y: -10, width: 900, height: 20 })?.x,
    400,
  );
  assert.equal(clampGuestBounds(view, { x: 0, y: 700, width: 10, height: 10 }), null);
});

test("snapshot uids are stable eN handles mapped to backend nodes", () => {
  assert.match(cdpSource, /unknown or stale uid/);
  const { tree, uids } = flattenAxTree([
    {
      nodeId: "1",
      role: { value: "WebArea" },
      childIds: ["2"],
    },
    {
      nodeId: "2",
      role: { value: "button" },
      name: { value: "Submit" },
      backendDOMNodeId: 42,
    },
  ]);
  assert.match(tree, /- e1 WebArea/);
  assert.match(tree, /- e2 button "Submit"/);
  assert.equal(uids.get("e2"), 42);
});

const runtimeSource = readFileSync(
  resolve("electron/main/plugin-runtime.ts"),
  "utf8",
);
const mainSource = readMainSourceSync();

test("in-flight tool.execute session survives the child host-api round trip", () => {
  assert.match(runtimeSource, /private executingToolSessions = new Map/);
  assert.match(runtimeSource, /stack.push\(\{ sessionId, toolName: name \}\)/);
  assert.match(runtimeSource, /this\.browserSessionId\(pluginId\)/);
});

test("legacy renderer browser IPC cannot place an unclamped guest", () => {
  const bounds = mainSource.slice(mainSource.indexOf("IPC.invoke.browserSetBounds"));
  const body = bounds.slice(0, bounds.indexOf("\n  handle("));
  assert.doesNotMatch(body, /browserPane\.setBounds/);
  assert.match(body, /Plugin chrome owns the clamped hole/);
  const visible = mainSource.slice(mainSource.indexOf("IPC.invoke.browserSetVisible"));
  const visibleBody = visible.slice(0, visible.indexOf("\n  handle("));
  assert.match(visibleBody, /plugins\.getLoaded\(BROWSER_PLUGIN_ID\)/);
  assert.doesNotMatch(visibleBody, /browserPane\.setVisible/);
});
